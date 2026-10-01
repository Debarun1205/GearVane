"""A learned classifier that augments the heuristic tier classifier.

The heuristics in classifier.py are transparent and predictable but do not
learn from outcomes. This module keeps a small logistic-regression style model
over hashed task-description features, trained from FeedbackLoop data, and
blends its prediction with the heuristic result.

Trained weights are stored as JSON so they can be versioned and inspected.
No third-party ML dependency is required.
"""

import json
import logging
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .classifier import ClassificationResult, TaskClassifier, TaskContext, Tier


logger = logging.getLogger(__name__)

TIERS = (Tier.LOCAL, Tier.MID, Tier.FRONTIER)
TIER_INDEX = {tier: i for i, tier in enumerate(TIERS)}


def tokenize(text: str) -> List[str]:
    """Split a description into lowercase word tokens."""
    return re.findall(r"[a-z0-9_]+", text.lower())


def features_for(text: str) -> Dict[str, float]:
    """Build a hashed bag-of-features vector for a description.

    Feature names are prefixed so word features and bigrams cannot collide
    with the structural features.
    """
    tokens = tokenize(text)
    counts: Dict[str, float] = defaultdict(float)

    for token in tokens:
        counts[f"w:{token}"] += 1.0

    # Bigrams capture short phrases like "security fix".
    for first, second in zip(tokens, tokens[1:]):
        counts[f"b:{first}_{second}"] += 1.0

    return dict(counts)


def normalize(features: Dict[str, float]) -> Dict[str, float]:
    """Scale a feature vector to unit L2 norm.

    Without this, raw token counts let the logit magnitudes grow without
    bound, softmax saturates on a single class, and the gradient for the
    correct class collapses to zero, so training stalls at chance accuracy.
    """
    total = sum(value * value for value in features.values())
    if total == 0:
        return features
    scale = 1.0 / math.sqrt(total)
    return {name: value * scale for name, value in features.items()}


@dataclass
class LearnedWeights:
    """Per-tier weight vectors and bias terms."""
    # tier -> feature name -> weight
    weights: Dict[str, Dict[str, float]] = field(default_factory=dict)
    bias: Dict[str, float] = field(default_factory=dict)
    trained_on: int = 0
    accuracy: float = 0.0

    def to_dict(self) -> dict:
        return {
            "weights": self.weights,
            "bias": self.bias,
            "trained_on": self.trained_on,
            "accuracy": self.accuracy,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LearnedWeights":
        return cls(
            weights=data.get("weights", {}),
            bias=data.get("bias", {}),
            trained_on=data.get("trained_on", 0),
            accuracy=data.get("accuracy", 0.0),
        )

    def is_trained(self) -> bool:
        return self.trained_on > 0


class LearnedClassifier:
    """Multinomial logistic regression over hashed description features."""

    def __init__(self, learning_rate: float = 0.1, epochs: int = 30,
                 l2: float = 0.001):
        self.learning_rate = learning_rate
        self.epochs = epochs
        self.l2 = l2
        self.weights = LearnedWeights()
        self._tier_keys = [t.value for t in TIERS]

    def _scores(self, features: Dict[str, float]) -> Dict[str, float]:
        """Compute a raw score per tier."""
        result = {}
        for tier_key in self._tier_keys:
            tier_weights = self.weights.weights.get(tier_key, {})
            score = self.weights.bias.get(tier_key, 0.0)
            for name, value in features.items():
                score += tier_weights.get(name, 0.0) * value
            result[tier_key] = score
        return result

    def _softmax(self, scores: Dict[str, float]) -> Dict[str, float]:
        """Numerically stable softmax over tier scores."""
        max_score = max(scores.values())
        exps = {k: math.exp(v - max_score) for k, v in scores.items()}
        total = sum(exps.values())
        if total == 0:
            return {k: 1.0 / len(exps) for k in exps}
        return {k: v / total for k, v in exps.items()}

    def predict_proba(self, description: str) -> Dict[str, float]:
        """Return per-tier probabilities. Untrained models are uniform."""
        if not self.weights.is_trained():
            uniform = 1.0 / len(TIERS)
            return {t.value: uniform for t in TIERS}

        features = normalize(features_for(description))
        return self._softmax(self._scores(features))

    def predict(self, description: str) -> Tuple[Tier, float]:
        """Predict a tier and its confidence."""
        probabilities = self.predict_proba(description)
        best_key = max(probabilities, key=probabilities.get)
        return Tier(best_key), probabilities[best_key]

    def train(self, samples: Sequence[Tuple[str, Tier]]) -> LearnedWeights:
        """Fit weights from (description, true_tier) pairs."""
        if not samples:
            logger.warning("No training samples supplied")
            return self.weights

        # Initialize zeroed weight vectors per tier.
        for tier_key in self._tier_keys:
            self.weights.weights[tier_key] = defaultdict(float)
            self.weights.bias[tier_key] = 0.0

        prepared = [
            (normalize(features_for(description)), TIER_INDEX[tier])
            for description, tier in samples
        ]

        for epoch in range(self.epochs):
            # Shuffle deterministically by reversing every other pass so
            # training does not depend on input order.
            if epoch % 2 == 1:
                prepared = list(reversed(prepared))

            for features, true_index in prepared:
                scores = self._scores(features)
                probabilities = self._softmax(scores)

                for tier_key in self._tier_keys:
                    tier_index = TIER_INDEX[Tier(tier_key)]
                    target = 1.0 if tier_index == true_index else 0.0

                    # Gradient ascent on the log-likelihood needs (y - p).
                    # Using (p - y) here would descend away from the correct
                    # class and training would settle at chance accuracy.
                    error = target - probabilities[tier_key]

                    self.weights.bias[tier_key] += self.learning_rate * error

                    tier_weights = self.weights.weights[tier_key]
                    for name, value in features.items():
                        tier_weights[name] += self.learning_rate * error * value

            # L2 regularization applied each epoch.
            if self.l2 > 0:
                for tier_weights in self.weights.weights.values():
                    for name in tier_weights:
                        tier_weights[name] *= (1.0 - self.l2)

        # Mark the model trained before scoring: predict() delegates to
        # predict_proba(), which returns a uniform distribution while
        # trained_on is still zero, which would score every sample wrong.
        self.weights.trained_on = len(samples)

        correct = 0
        for description, true_tier in samples:
            predicted, _ = self.predict(description)
            if predicted == true_tier:
                correct += 1

        self.weights.accuracy = correct / len(samples)

        logger.info(
            f"Trained on {len(samples)} samples, "
            f"training accuracy {self.weights.accuracy:.1%}"
        )
        return self.weights

    def save(self, path: str):
        """Persist weights as JSON."""
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(self.weights.to_dict(), f, indent=2, sort_keys=True)
        logger.info(f"Saved model to {path}")

    @classmethod
    def load(cls, path: str, **kwargs) -> "LearnedClassifier":
        """Load weights from JSON, returning an untrained model if absent."""
        classifier = cls(**kwargs)
        path_obj = Path(path)
        if path_obj.exists():
            with open(path_obj) as f:
                classifier.weights = LearnedWeights.from_dict(json.load(f))
            logger.info(
                f"Loaded model from {path} "
                f"({classifier.weights.trained_on} samples)"
            )
        return classifier

    def top_features(self, tier: Tier, n: int = 10) -> List[Tuple[str, float]]:
        """Inspect the strongest positive weights for a tier."""
        tier_weights = self.weights.weights.get(tier.value, {})
        ranked = sorted(tier_weights.items(), key=lambda kv: -kv[1])
        return [(name, round(weight, 4)) for name, weight in ranked[:n] if weight > 0][:n]


class HybridClassifier:
    """Blends heuristic and learned classification.

    The learned model only gets weight once it has enough training data;
    before that the heuristic result stands alone. This keeps behaviour
    predictable on a fresh install.
    """

    def __init__(self, config: Optional[dict] = None,
                 learned: Optional[LearnedClassifier] = None,
                 min_samples: int = 10,
                 blend: float = 0.5):
        self.heuristic = TaskClassifier(config)
        self.learned = learned or LearnedClassifier()
        self.min_samples = min_samples
        self.blend = blend

    @property
    def learned_ready(self) -> bool:
        return self.learned.weights.trained_on >= self.min_samples

    def classify(self, context: TaskContext) -> ClassificationResult:
        """Classify using heuristics, refined by the learned model if ready."""
        heuristic = self.heuristic.classify(context)

        if not self.learned_ready:
            heuristic.reasons.append(
                f"Learned model not active "
                f"({self.learned.weights.trained_on}/{self.min_samples} samples)"
            )
            return heuristic

        probabilities = self.learned.predict_proba(context.description)
        learned_key = max(probabilities, key=probabilities.get)
        learned_tier = Tier(learned_key)
        learned_confidence = probabilities[learned_key]

        # Blend tier confidence. When the two models disagree the result is
        # the heuristic's tier at reduced confidence, so a bad learned model
        # degrades gracefully instead of silently rerouting work.
        agree = learned_tier == heuristic.tier
        combined = (self.blend * learned_confidence +
                    (1 - self.blend) * heuristic.confidence)

        if agree:
            tier = heuristic.tier
        else:
            tier = heuristic.tier
            combined *= 0.75

        reasons = list(heuristic.reasons)
        reasons.append(
            f"Learned model favoured {learned_tier.value} "
            f"({learned_confidence:.0%}); "
            + ("agreed with heuristics" if agree else "overridden by heuristics")
        )

        return ClassificationResult(
            tier=tier,
            confidence=round(min(combined, 1.0), 2),
            reasons=reasons,
            scores=heuristic.scores,
        )


def train_from_feedback(model_path: str, feedback_path: str,
                        **kwargs) -> LearnedClassifier:
    """Train a classifier from stored FeedbackLoop data."""
    from .feedback import FeedbackStore

    store = FeedbackStore(feedback_path)
    samples = [
        (entry.description, Tier(entry.actual_tier))
        for entry in store.get_entries()
        if entry.actual_tier
    ]

    classifier = LearnedClassifier(**kwargs)
    classifier.train(samples)
    classifier.save(model_path)
    return classifier