"""Cost tracking and budget alerts."""

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class AlertLevel(Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class BudgetAlert:
    level: AlertLevel
    message: str
    current_spend: float
    limit: float
    timestamp: float = field(default_factory=time.time)


@dataclass
class CostEntry:
    timestamp: float
    task_id: str
    tier: str
    model: str
    tokens_in: int
    tokens_out: int
    cost_usd: float


class CostTracker:
    """Tracks model usage costs and triggers budget alerts."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        budget_config = self.config.get("budget", {})

        self.per_session_limit = budget_config.get("per_session", 10.0)
        self.per_day_limit = budget_config.get("per_day", 50.0)
        self.per_task_limit = budget_config.get("per_task", 5.0)

        # Alert thresholds (percentage of limit)
        self.warning_threshold = budget_config.get("warning_threshold", 0.7)
        self.critical_threshold = budget_config.get("critical_threshold", 0.9)

        self._entries: List[CostEntry] = []
        self._session_start = time.time()
        self._day_start = time.time()
        self._alert_handlers: List[Callable[[BudgetAlert], None]] = []

        # Alert state to prevent spam
        self._last_alert_level: Dict[str, AlertLevel] = {}

    def add_alert_handler(self, handler: Callable[[BudgetAlert], None]):
        """Register a handler for budget alerts."""
        self._alert_handlers.append(handler)

    def record_usage(
        self,
        task_id: str,
        tier: str,
        model: str,
        tokens_in: int,
        tokens_out: int,
        cost_per_token: float,
    ):
        """Record model usage and cost."""
        cost = (tokens_in + tokens_out) * cost_per_token

        entry = CostEntry(
            timestamp=time.time(),
            task_id=task_id,
            tier=tier,
            model=model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=cost,
        )
        self._entries.append(entry)

        logger.info(
            f"Cost: task={task_id} model={model} tokens={tokens_in}+{tokens_out} cost=${cost:.4f}"
        )

        self._check_budgets(cost)

    def _check_budgets(self, latest_cost: float):
        """Check if any budget thresholds are crossed."""
        session_spend = self.get_session_spend()
        day_spend = self.get_day_spend()

        # Check session budget
        if session_spend >= self.per_session_limit:
            self._emit_alert(
                AlertLevel.CRITICAL,
                "Session budget exceeded",
                session_spend,
                self.per_session_limit,
                "session",
            )
        elif session_spend >= self.per_session_limit * self.critical_threshold:
            self._emit_alert(
                AlertLevel.WARNING,
                "Session budget near limit",
                session_spend,
                self.per_session_limit,
                "session",
            )

        # Check day budget
        if day_spend >= self.per_day_limit:
            self._emit_alert(
                AlertLevel.CRITICAL, "Daily budget exceeded", day_spend, self.per_day_limit, "day"
            )
        elif day_spend >= self.per_day_limit * self.critical_threshold:
            self._emit_alert(
                AlertLevel.WARNING, "Daily budget near limit", day_spend, self.per_day_limit, "day"
            )

    def _emit_alert(
        self, level: AlertLevel, message: str, current: float, limit: float, budget_type: str
    ):
        """Emit a budget alert if not already at this level."""
        last_level = self._last_alert_level.get(budget_type)
        if last_level == level:
            return  # Don't spam same alert level

        self._last_alert_level[budget_type] = level

        alert = BudgetAlert(
            level=level,
            message=message,
            current_spend=current,
            limit=limit,
        )

        logger.warning(f"BUDGET ALERT [{level.value}]: {message} (${current:.2f}/${limit:.2f})")

        for handler in self._alert_handlers:
            try:
                handler(alert)
            except Exception as e:
                logger.error(f"Alert handler failed: {e}")

    def get_session_spend(self) -> float:
        """Get total spend for current session."""
        return sum(e.cost_usd for e in self._entries)

    def get_day_spend(self) -> float:
        """Get total spend for current day."""
        day_ago = time.time() - 86400
        return sum(e.cost_usd for e in self._entries if e.timestamp >= day_ago)

    def get_task_spend(self, task_id: str) -> float:
        """Get total spend for a specific task."""
        return sum(e.cost_usd for e in self._entries if e.task_id == task_id)

    def get_stats(self) -> Dict[str, Any]:
        """Get cost statistics."""
        if not self._entries:
            return {"total": 0, "total_cost": 0.0}

        total_in = sum(e.tokens_in for e in self._entries)
        total_out = sum(e.tokens_out for e in self._entries)
        total_cost = sum(e.cost_usd for e in self._entries)

        # Cost by tier
        tier_costs: Dict[str, float] = {}
        for e in self._entries:
            tier_costs[e.tier] = tier_costs.get(e.tier, 0.0) + e.cost_usd

        # Cost by model
        model_costs: Dict[str, float] = {}
        for e in self._entries:
            model_costs[e.model] = model_costs.get(e.model, 0.0) + e.cost_usd

        return {
            "total_calls": len(self._entries),
            "total_tokens_in": total_in,
            "total_tokens_out": total_out,
            "total_cost_usd": round(total_cost, 4),
            "session_spend_usd": round(self.get_session_spend(), 4),
            "day_spend_usd": round(self.get_day_spend(), 4),
            "cost_by_tier": {k: round(v, 4) for k, v in tier_costs.items()},
            "cost_by_model": {k: round(v, 4) for k, v in model_costs.items()},
        }

    def reset_session(self):
        """Reset session tracking."""
        self._entries.clear()
        self._session_start = time.time()
        self._last_alert_level.clear()
