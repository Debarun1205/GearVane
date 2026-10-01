"""Logging for routing decisions, escalations, and costs."""

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class RoutingLogEntry:
    timestamp: float
    task_id: str
    tier: str
    provider: str
    model: str
    confidence: float
    reasons: List[str]
    escalated: bool
    attempt: int
    success: Optional[bool] = None
    cost_usd: float = 0.0
    duration_seconds: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)


class RoutingLogger:
    """Logs routing decisions and outcomes for analysis."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.enabled = self.config.get("enabled", True)
        self.level = self.config.get("level", "INFO")
        self.log_file = self.config.get("file", "waypoint.log")
        self.log_decisions = self.config.get("log_routing_decisions", True)
        self.log_escalations = self.config.get("log_escalations", True)
        self.log_costs = self.config.get("log_costs", True)

        self._entries: List[RoutingLogEntry] = []
        self._setup_file_logging()

    def _setup_file_logging(self):
        """Set up Python logging to file."""
        if not self.enabled:
            return

        log_path = Path(self.log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        logging.basicConfig(
            level=getattr(logging, self.level.upper()),
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            handlers=[
                logging.FileHandler(self.log_file),
                logging.StreamHandler(),
            ],
        )

    def log_routing(self, task_id: str, decision, context=None):
        """Log a routing decision.

        Entries are always recorded in memory so `stats` and `cost` reflect
        what actually ran. The enabled/log_routing_decisions flags control
        file and stream output only.
        """
        if not self.log_decisions:
            return

        entry = RoutingLogEntry(
            timestamp=time.time(),
            task_id=task_id,
            tier=decision.tier.value,
            provider=decision.provider.name,
            model=decision.model,
            confidence=decision.confidence,
            reasons=decision.reasons,
            escalated=decision.escalated,
            attempt=decision.attempt,
        )
        self._entries.append(entry)

        logger = logging.getLogger("waypoint.router")
        logger.info(
            f"Route: task={task_id} tier={entry.tier} "
            f"model={entry.model} confidence={entry.confidence} "
            f"escalated={entry.escalated}"
        )

    def log_outcome(
        self,
        task_id: str,
        success: bool,
        cost_usd: float = 0.0,
        duration_seconds: float = 0.0,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """Log the outcome of a routed task.

        Recorded in memory regardless of the enabled flag, so stats stay
        accurate when file logging is off.
        """
        # Find the latest entry for this task
        for entry in reversed(self._entries):
            if entry.task_id == task_id:
                entry.success = success
                entry.cost_usd = cost_usd
                entry.duration_seconds = duration_seconds
                if metadata:
                    entry.metadata.update(metadata)
                break

        logger = logging.getLogger("waypoint.outcome")
        status = "SUCCESS" if success else "FAILURE"
        logger.info(
            f"Outcome: task={task_id} status={status} "
            f"cost=${cost_usd:.4f} duration={duration_seconds:.2f}s"
        )

    def log_escalation(self, task_id: str, from_tier: str, to_tier: str, reason: str):
        """Log an escalation event."""
        if not self.enabled or not self.log_escalations:
            return

        logger = logging.getLogger("waypoint.escalation")
        logger.warning(f"Escalation: task={task_id} {from_tier} -> {to_tier} ({reason})")

    def get_stats(self) -> Dict[str, Any]:
        """Get routing statistics."""
        if not self._entries:
            return {"total": 0}

        total = len(self._entries)
        escalations = sum(1 for e in self._entries if e.escalated)
        successes = sum(1 for e in self._entries if e.success is True)
        failures = sum(1 for e in self._entries if e.success is False)
        total_cost = sum(e.cost_usd for e in self._entries)

        tier_counts: Dict[str, int] = {}
        for e in self._entries:
            tier_counts[e.tier] = tier_counts.get(e.tier, 0) + 1

        return {
            "total": total,
            "escalations": escalations,
            "successes": successes,
            "failures": failures,
            "total_cost_usd": round(total_cost, 4),
            "tier_distribution": tier_counts,
        }

    def export_json(self, filepath: str):
        """Export all log entries to JSON."""
        data = [asdict(entry) for entry in self._entries]
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2, default=str)
