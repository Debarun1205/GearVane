"""End-to-end task execution.

Ties the router, providers, cost tracking, feedback, and safety together so
a single call routes a task, executes it, records cost, and escalates on
failure.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional

from .classifier import TaskContext, Tier
from .cost import CostTracker
from .providers import Completion, ProviderError, ProviderFactory
from .retry import RetryConfig, RetryExhaustedError, retry_sync
from .router import RoutingDecision, TierRouter
from .safety import SafetyManager


logger = logging.getLogger(__name__)


class BudgetExceeded(Exception):
    """Raised when a task would exceed its configured spend budget."""


class RetryableProviderError(Exception):
    """Wraps a transient provider failure so the retry loop picks it up."""


class NonRetryableError(Exception):
    """A permanent provider failure. Retrying cannot help."""


@dataclass
class ExecutionResult:
    """Outcome of running one task end to end."""
    task_id: str
    success: bool
    content: str = ""
    tier: Optional[str] = None
    model: Optional[str] = None
    provider: Optional[str] = None
    attempts: int = 0
    escalated: bool = False
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    duration_seconds: float = 0.0
    confidence: float = 0.0
    reasons: List[str] = field(default_factory=list)
    error: str = ""
    history: List[Dict[str, Any]] = field(default_factory=list)


class Orchestrator:
    """Routes and executes tasks with escalation, retries, and budget checks."""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.router = TierRouter(config)
        self.safety = SafetyManager(config)
        self.cost = CostTracker(config)
        self.providers = ProviderFactory(
            timeout=config.get("providers", {}).get("timeout_seconds", 120.0)
        )

        self._max_escalations = config.get("router", {}).get("escalation", {}).get(
            "max_escalations", 2
        )
        self._cost_per_token = {
            tier.name.lower(): tier.cost_per_token
            for tier in self.router.tiers.values()
        }

    def execute(self, task_id: str, prompt: str,
                files_touched: Optional[List[str]] = None,
                system: Optional[str] = None,
                temperature: float = 0.0,
                max_tokens: int = 2048,
                error_loops: int = 0,
                test_failures: int = 0) -> ExecutionResult:
        """Route and run a task, retrying and escalating as needed."""
        start = time.time()
        history: List[Dict[str, Any]] = []
        total_cost = 0.0
        total_in = 0
        total_out = 0

        for attempt in range(self._max_escalations + 1):
            context = TaskContext(
                description=prompt,
                files_touched=files_touched or [],
                error_loops=error_loops,
                test_failures=test_failures,
            )
            decision = self.router.route(task_id, context)

            # Budget gate runs before any tokens are spent.
            unit_cost = self._cost_per_token.get(decision.tier.value, 0.0)
            estimated = unit_cost * max_tokens
            if not self.safety.check_spend(estimated, task_id=task_id):
                return ExecutionResult(
                    task_id=task_id,
                    success=False,
                    tier=decision.tier.value,
                    model=decision.model,
                    provider=decision.provider.name,
                    attempts=attempt + 1,
                    escalated=decision.escalated,
                    duration_seconds=time.time() - start,
                    confidence=decision.confidence,
                    reasons=decision.reasons,
                    error=f"Budget exceeded: ${estimated:.4f} would exceed the limit",
                    history=history,
                )

            logger.info(
                f"Executing {task_id} on {decision.provider.name}/{decision.model} "
                f"({decision.tier.value})"
            )

            try:
                completion = self._call_with_retry(
                    decision, prompt, system, temperature, max_tokens
                )
            except (ProviderError, RetryExhaustedError, RetryableProviderError,
                    NonRetryableError) as e:
                message = str(e)
                logger.warning(f"Task {task_id} attempt {attempt + 1} failed: {message}")

                self.router.report_failure(task_id)
                self.cost.record_usage(
                    task_id, decision.tier.value, decision.model, 0, 0, 0.0
                )
                history.append({
                    "attempt": attempt + 1,
                    "tier": decision.tier.value,
                    "model": decision.model,
                    "success": False,
                    "error": message,
                })

                # Feed the failure into the next classification so the router
                # sees the error count and can escalate.
                error_loops += 1
                continue

            # Success path.
            cost = unit_cost * completion.usage.total
            total_cost += cost
            total_in += completion.usage.tokens_in
            total_out += completion.usage.tokens_out

            self.cost.record_usage(
                task_id, decision.tier.value, decision.model,
                completion.usage.tokens_in, completion.usage.tokens_out, unit_cost,
            )
            self.safety.record_spend(cost, task_id=task_id)
            self.router.report_success(task_id)

            history.append({
                "attempt": attempt + 1,
                "tier": decision.tier.value,
                "model": decision.model,
                "success": True,
                "cost_usd": round(cost, 6),
            })

            return ExecutionResult(
                task_id=task_id,
                success=True,
                content=completion.content,
                tier=decision.tier.value,
                model=decision.model,
                provider=decision.provider.name,
                attempts=attempt + 1,
                escalated=decision.escalated,
                cost_usd=round(total_cost, 6),
                tokens_in=total_in,
                tokens_out=total_out,
                duration_seconds=round(time.time() - start, 3),
                confidence=decision.confidence,
                reasons=decision.reasons,
                history=history,
            )

        # Every attempt failed.
        return ExecutionResult(
            task_id=task_id,
            success=False,
            attempts=self._max_escalations + 1,
            duration_seconds=round(time.time() - start, 3),
            error="All attempts failed",
            history=history,
        )

    def _call_with_retry(self, decision: RoutingDecision, prompt: str,
                         system: Optional[str], temperature: float,
                         max_tokens: int) -> Completion:
        """Call the provider with retry on transient failures only.

        Only retryable ProviderErrors are retried. Permanent failures (bad
        request, auth, protocol violations) are re-raised as
        NonRetryableError so the retry loop stops on the first attempt
        instead of burning every retry on an unrecoverable call.
        """
        client = self.providers.create(decision.provider, decision.model)
        retry_config = RetryConfig(
            max_retries=self.config.get("providers", {}).get("max_retries", 2),
            base_delay=self.config.get("providers", {}).get("retry_base_delay", 1.0),
            max_delay=self.config.get("providers", {}).get("retry_max_delay", 30.0),
            retryable_exceptions=(RetryableProviderError,),
        )

        def call():
            try:
                return client.complete(
                    prompt,
                    system=system,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            except ProviderError as e:
                if e.retryable:
                    raise RetryableProviderError(str(e)) from e
                raise NonRetryableError(str(e)) from e

        return retry_sync(call, retry_config)

    def execute_stream(self, task_id: str, prompt: str,
                       files_touched: Optional[List[str]] = None,
                       system: Optional[str] = None,
                       temperature: float = 0.0,
                       max_tokens: int = 2048) -> Iterator[str]:
        """Route a task and stream the response token by token."""
        context = TaskContext(
            description=prompt,
            files_touched=files_touched or [],
        )
        decision = self.router.route(task_id, context)
        client = self.providers.create(decision.provider, decision.model)

        for token in client.stream(
            prompt, system=system, temperature=temperature, max_tokens=max_tokens
        ):
            yield token