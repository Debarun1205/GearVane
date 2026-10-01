"""Tier router that selects models and manages escalation."""

import logging
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any

from .classifier import TaskClassifier, TaskContext, Tier, ClassificationResult


logger = logging.getLogger(__name__)


@dataclass
class ModelProvider:
    name: str
    models: List[str]
    base_url: Optional[str] = None
    api_key_env: Optional[str] = None


@dataclass
class TierConfig:
    name: str
    description: str
    providers: List[ModelProvider]
    max_retries: int = 2
    cost_per_token: float = 0.0


@dataclass
class RoutingDecision:
    tier: Tier
    provider: ModelProvider
    model: str
    confidence: float
    reasons: List[str]
    escalated: bool = False
    attempt: int = 1


class TierRouter:
    """Routes tasks to appropriate model tiers with escalation support."""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.tiers: Dict[Tier, TierConfig] = {}
        self.classifier = TaskClassifier(config.get("router", {}))
        self.escalation_config = config.get("router", {}).get("escalation", {})
        self.manual_override = config.get("router", {}).get("manual_override")
        self.default_tier = Tier(config.get("router", {}).get("default_tier", "mid"))
        
        self._load_tiers(config.get("tiers", {}))
        
        # Track attempts per task
        self._task_attempts: Dict[str, Dict[str, Any]] = {}

    def _load_tiers(self, tiers_config: dict):
        """Load tier configurations."""
        for tier_name, tier_data in tiers_config.items():
            tier = Tier(tier_name)
            providers = []
            for prov_data in tier_data.get("providers", []):
                providers.append(ModelProvider(
                    name=prov_data["name"],
                    models=prov_data.get("models", []),
                    base_url=prov_data.get("base_url"),
                    api_key_env=prov_data.get("api_key_env"),
                ))
            self.tiers[tier] = TierConfig(
                name=tier_name,
                description=tier_data.get("description", ""),
                providers=providers,
                max_retries=tier_data.get("max_retries", 2),
                cost_per_token=tier_data.get("cost_per_token", 0.0),
            )

    def _resolve_override(self, override: str):
        """Resolve a manual override string to a (tier, provider, model) triple.

        Accepts either a bare model name ("gpt-4o") or a qualified
        "provider/model" string ("openai/gpt-4o"). Returns None if the
        override does not match any configured model.
        """
        override = override.strip()

        # Split an optional "provider/model" qualifier.
        provider_hint = None
        model_name = override
        if "/" in override:
            provider_hint, model_name = override.split("/", 1)
            # A provider name may itself contain "/" (e.g. openrouter/anthropic/claude).
            # Re-join anything that matches a configured provider prefix.
            for tier_config in self.tiers.values():
                for provider in tier_config.providers:
                    prefix = f"{provider.name}/"
                    if override.startswith(prefix):
                        provider_hint = provider.name
                        model_name = override[len(prefix):]
                        break

        for tier, tier_config in self.tiers.items():
            for provider in tier_config.providers:
                if provider_hint and provider.name != provider_hint:
                    continue
                for model in provider.models:
                    if model == model_name:
                        return (tier, provider, model)

        return None

    def route(self, task_id: str, context: TaskContext) -> RoutingDecision:
        """Route a task to the appropriate tier and model."""
        # Check manual override
        if self.manual_override:
            resolved = self._resolve_override(self.manual_override)
            if resolved:
                tier, provider, model = resolved
                logger.info(
                    f"Manual override active: {self.manual_override} "
                    f"-> {provider.name}/{model} (tier={tier.value})"
                )
                return RoutingDecision(
                    tier=tier,
                    provider=provider,
                    model=model,
                    confidence=1.0,
                    reasons=[f"Manual override: {self.manual_override}"],
                    escalated=False,
                    attempt=1,
                )

            # An override that matches nothing must not silently degrade to
            # normal routing, because the user explicitly asked for a model.
            logger.warning(
                f"Manual override '{self.manual_override}' matched no configured "
                f"model. Falling back to automatic routing. "
                f"Check 'router.manual_override' in your config."
            )

        # Get or create task tracking
        if task_id not in self._task_attempts:
            self._task_attempts[task_id] = {
                "attempts": 0,
                "tier": None,
                "failures": 0,
            }

        task_state = self._task_attempts[task_id]
        task_state["attempts"] += 1

        # Classify the task
        classification = self.classifier.classify(context)
        logger.info(f"Task {task_id} classified as {classification.tier.value} "
                    f"(confidence: {classification.confidence})")

        # Check for escalation
        escalated = False
        if self.escalation_config.get("enabled", True):
            max_attempts = self.escalation_config.get("max_attempts_per_tier", 2)
            if task_state["failures"] >= max_attempts:
                # Escalate to next tier
                current_tier = classification.tier
                if current_tier == Tier.LOCAL:
                    classification.tier = Tier.MID
                elif current_tier == Tier.MID:
                    classification.tier = Tier.FRONTIER
                escalated = True
                task_state["failures"] = 0
                logger.warning(f"Task {task_id} escalated to {classification.tier.value}")

        # Select provider and model
        tier_config = self.tiers.get(classification.tier)
        if not tier_config or not tier_config.providers:
            # Fallback to default tier
            logger.warning(f"No config for tier {classification.tier.value}, "
                          f"falling back to {self.default_tier.value}")
            tier_config = self.tiers.get(self.default_tier)
            classification.tier = self.default_tier

        # Simple round-robin provider selection
        provider_idx = (task_state["attempts"] - 1) % len(tier_config.providers)
        provider = tier_config.providers[provider_idx]
        
        # Select first available model (could be smarter)
        model = provider.models[0] if provider.models else "default"

        task_state["tier"] = classification.tier

        return RoutingDecision(
            tier=classification.tier,
            provider=provider,
            model=model,
            confidence=classification.confidence,
            reasons=classification.reasons,
            escalated=escalated,
            attempt=task_state["attempts"],
        )

    def report_failure(self, task_id: str):
        """Report a task failure to trigger escalation on next route."""
        if task_id in self._task_attempts:
            self._task_attempts[task_id]["failures"] += 1
            logger.info(f"Task {task_id} failure recorded "
                        f"({self._task_attempts[task_id]['failures']} total)")

    def report_success(self, task_id: str):
        """Report a task success."""
        if task_id in self._task_attempts:
            self._task_attempts[task_id]["failures"] = 0
            logger.info(f"Task {task_id} succeeded")

    def get_task_history(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Get the routing history for a task."""
        return self._task_attempts.get(task_id)
