"""Feedback loop for improving classification accuracy over time."""

import json
import logging
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class FeedbackEntry:
    task_id: str
    description: str
    predicted_tier: str
    actual_tier: Optional[str] = None
    was_correct: Optional[bool] = None
    user_rating: Optional[int] = None  # 1-5 scale
    timestamp: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)


class FeedbackStore:
    """Stores and manages classification feedback."""

    def __init__(self, storage_path: str = "feedback.jsonl"):
        self.storage_path = Path(storage_path)
        self._entries: List[FeedbackEntry] = []
        self._load()

    def _load(self):
        """Load existing feedback from disk."""
        if self.storage_path.exists():
            with open(self.storage_path) as f:
                for line in f:
                    data = json.loads(line.strip())
                    self._entries.append(FeedbackEntry(**data))

    def _save(self):
        """Save feedback to disk."""
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.storage_path, "w") as f:
            for entry in self._entries:
                f.write(json.dumps(asdict(entry)) + "\n")

    def add(self, entry: FeedbackEntry):
        """Add a feedback entry."""
        self._entries.append(entry)
        self._save()
        logger.info(f"Feedback recorded for task {entry.task_id}")

    def get_entries(self, limit: Optional[int] = None) -> List[FeedbackEntry]:
        """Get feedback entries."""
        if limit:
            return self._entries[-limit:]
        return self._entries.copy()

    def get_stats(self) -> Dict[str, Any]:
        """Get feedback statistics."""
        if not self._entries:
            # Same keys as the populated branch so callers need no special case.
            return {
                "total_entries": 0,
                "rated_entries": 0,
                "correct_predictions": 0,
                "incorrect_predictions": 0,
                "accuracy": 0.0,
                "average_rating": 0.0,
                "by_tier": {},
            }

        total = len(self._entries)
        rated = [e for e in self._entries if e.user_rating is not None]
        correct = [e for e in self._entries if e.was_correct is True]
        incorrect = [e for e in self._entries if e.was_correct is False]

        ratings = [e.user_rating for e in rated if e.user_rating is not None]
        avg_rating = sum(ratings) / len(ratings) if ratings else 0

        # Accuracy by tier
        tier_stats: Dict[str, Dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
        for entry in self._entries:
            tier_stats[entry.predicted_tier]["total"] += 1
            if entry.was_correct:
                tier_stats[entry.predicted_tier]["correct"] += 1

        return {
            "total_entries": total,
            "rated_entries": len(rated),
            "correct_predictions": len(correct),
            "incorrect_predictions": len(incorrect),
            "accuracy": len(correct) / total if total > 0 else 0,
            "average_rating": round(avg_rating, 2),
            "by_tier": {
                tier: {
                    "total": stats["total"],
                    "correct": stats["correct"],
                    "accuracy": stats["correct"] / stats["total"] if stats["total"] > 0 else 0,
                }
                for tier, stats in tier_stats.items()
            },
        }


class FeedbackLoop:
    """Manages the feedback loop for classification improvement."""

    def __init__(self, store: Optional[FeedbackStore] = None):
        self.store = store or FeedbackStore()
        self._adjustment_callbacks: List = []

    def record_prediction(self, task_id: str, description: str, predicted_tier: str):
        """Record a classification prediction."""
        entry = FeedbackEntry(
            task_id=task_id,
            description=description,
            predicted_tier=predicted_tier,
        )
        self.store.add(entry)
        return entry

    def record_outcome(self, task_id: str, actual_tier: str, user_rating: Optional[int] = None):
        """Record the actual outcome for a prediction."""
        # Find the entry
        for entry in reversed(self.store.get_entries()):
            if entry.task_id == task_id and entry.actual_tier is None:
                entry.actual_tier = actual_tier
                entry.was_correct = entry.predicted_tier == actual_tier
                entry.user_rating = user_rating
                self.store._save()

                if not entry.was_correct:
                    logger.warning(
                        f"Misclassification: task={task_id} "
                        f"predicted={entry.predicted_tier} actual={actual_tier}"
                    )
                break

    def get_adjustment_suggestions(self) -> List[Dict[str, Any]]:
        """Analyze feedback and suggest classification adjustments."""
        stats = self.store.get_stats()
        suggestions = []

        # Find tiers with low accuracy
        for tier, tier_stats in stats.get("by_tier", {}).items():
            if tier_stats["accuracy"] < 0.6 and tier_stats["total"] >= 5:
                suggestions.append(
                    {
                        "type": "low_accuracy",
                        "tier": tier,
                        "accuracy": tier_stats["accuracy"],
                        "message": (
                            f"Tier '{tier}' has low accuracy "
                            f"({tier_stats['accuracy']:.0%}). Consider "
                            "adjusting keywords or thresholds."
                        ),
                    }
                )

        # Find commonly misclassified descriptions
        misclassified = [e for e in self.store.get_entries() if e.was_correct is False]

        # Group by predicted tier
        by_tier = defaultdict(list)
        for entry in misclassified:
            by_tier[entry.predicted_tier].append(entry)

        for tier, entries in by_tier.items():
            if len(entries) >= 3:
                suggestions.append(
                    {
                        "type": "common_misclassification",
                        "tier": tier,
                        "count": len(entries),
                        "message": f"Tier '{tier}' has {len(entries)} misclassifications. "
                        f"Review recent tasks for patterns.",
                    }
                )

        return suggestions

    def export_feedback(self, filepath: str):
        """Export all feedback to a JSON file."""
        entries = [asdict(e) for e in self.store.get_entries()]
        with open(filepath, "w") as f:
            json.dump(entries, f, indent=2, default=str)

    def get_training_data(self) -> List[Dict[str, Any]]:
        """Get feedback data formatted for classifier training."""
        training_data = []
        for entry in self.store.get_entries():
            if entry.actual_tier:
                training_data.append(
                    {
                        "description": entry.description,
                        "tier": entry.actual_tier,
                        "metadata": entry.metadata,
                    }
                )
        return training_data
