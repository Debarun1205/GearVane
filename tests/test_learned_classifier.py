"""Tests for the learned classifier and hybrid routing."""

import json

import pytest

from waypoint.classifier import TaskContext, Tier
from waypoint.learned_classifier import (
    HybridClassifier,
    LearnedClassifier,
    features_for,
    tokenize,
    train_from_feedback,
)

SAMPLES = [
    # Simple / local
    ("fix a typo in the readme", Tier.LOCAL),
    ("update the changelog typo", Tier.LOCAL),
    ("rename this variable for clarity", Tier.LOCAL),
    ("fix spelling in the documentation", Tier.LOCAL),
    ("simple formatting change in the readme", Tier.LOCAL),
    ("add a comment to this function", Tier.LOCAL),
    ("fix a typo in the template", Tier.LOCAL),
    ("small readme formatting fix", Tier.LOCAL),
    # Medium / mid
    ("add pagination to the user list endpoint", Tier.MID),
    ("wire up the new settings form to the api", Tier.MID),
    ("update the dashboard chart colours", Tier.MID),
    ("add validation to the signup form", Tier.MID),
    ("update the api response for list endpoints", Tier.MID),
    ("add loading state to the profile page", Tier.MID),
    ("render the recent activity list", Tier.MID),
    ("add a retry to the http client wrapper", Tier.MID),
    # Complex / frontier
    ("refactor the authentication architecture", Tier.FRONTIER),
    ("optimize the database performance bottleneck", Tier.FRONTIER),
    ("investigate a concurrency race condition", Tier.FRONTIER),
    ("redesign the distributed migration system", Tier.FRONTIER),
    ("optimize the query performance at scale", Tier.FRONTIER),
    ("investigate the memory leak under concurrency", Tier.FRONTIER),
    ("refactor the architecture for security", Tier.FRONTIER),
    ("scale the distributed system architecture", Tier.FRONTIER),
]


class TestFeatureExtraction:
    def test_tokenize_lowercases_and_splits(self):
        assert tokenize("Fix A Typo") == ["fix", "a", "typo"]

    def test_features_include_words_and_bigrams(self):
        features = features_for("fix typo")
        assert features["w:fix"] == 1.0
        assert features["w:typo"] == 1.0
        assert features["b:fix_typo"] == 1.0

    def test_repeated_words_count(self):
        features = features_for("fix fix typo")
        assert features["w:fix"] == 2.0

    def test_features_are_deterministic(self):
        assert features_for("fix typo") == features_for("fix typo")


class TestUntrainedModel:
    def test_untrained_predicts_uniform(self):
        clf = LearnedClassifier()
        probabilities = clf.predict_proba("anything at all")
        assert len(probabilities) == 3
        for value in probabilities.values():
            assert value == pytest.approx(1 / 3)
        assert sum(probabilities.values()) == pytest.approx(1.0)

    def test_untrained_is_not_trained(self):
        assert LearnedClassifier().weights.is_trained() is False

    def test_train_with_no_samples_is_safe(self):
        clf = LearnedClassifier()
        clf.train([])
        assert clf.weights.is_trained() is False


class TestTraining:
    def setup_method(self):
        self.clf = LearnedClassifier(learning_rate=0.5, epochs=50)
        self.clf.train(SAMPLES)

    def test_learns_to_separate_simple_from_complex(self):
        assert self.clf.weights.trained_on == len(SAMPLES)
        assert self.clf.weights.accuracy > 0.8

    def test_predicts_local_for_simple(self):
        tier, confidence = self.clf.predict("fix a typo in the readme")
        assert tier == Tier.LOCAL
        assert confidence > 0.5

    def test_predicts_frontier_for_complex(self):
        tier, confidence = self.clf.predict("refactor the authentication architecture")
        assert tier == Tier.FRONTIER

    def test_probabilities_sum_to_one(self):
        probabilities = self.clf.predict_proba("fix a typo")
        assert sum(probabilities.values()) == pytest.approx(1.0)

    def test_training_is_deterministic(self):
        other = LearnedClassifier(learning_rate=0.5, epochs=50)
        other.train(SAMPLES)
        assert other.predict_proba("fix a typo") == self.clf.predict_proba("fix a typo")

    def test_top_features_are_positive_and_sorted(self):
        top = self.clf.top_features(Tier.FRONTIER, n=5)
        assert top
        weights = [w for _, w in top]
        assert weights == sorted(weights, reverse=True)
        assert all(w > 0 for w in weights)

    def test_generalizes_to_unseen_phrasing(self):
        # Not in the training set verbatim.
        tier, _ = self.clf.predict("investigate the concurrency bug in the scheduler")
        assert tier in (Tier.FRONTIER, Tier.MID)


class TestPersistence:
    def test_save_and_load_roundtrip(self, tmp_path):
        clf = LearnedClassifier(epochs=20)
        clf.train(SAMPLES)
        path = str(tmp_path / "model.json")
        clf.save(path)

        loaded = LearnedClassifier.load(path)
        assert loaded.weights.trained_on == clf.weights.trained_on
        assert loaded.predict("fix a typo") == clf.predict("fix a typo")

    def test_load_missing_file_returns_untrained(self, tmp_path):
        clf = LearnedClassifier.load(str(tmp_path / "nope.json"))
        assert clf.weights.is_trained() is False

    def test_saved_file_is_readable_json(self, tmp_path):
        clf = LearnedClassifier(epochs=10)
        clf.train(SAMPLES)
        path = tmp_path / "model.json"
        clf.save(str(path))
        data = json.loads(path.read_text())
        assert "weights" in data
        assert "bias" in data


class TestHybridClassifier:
    def test_heuristics_used_before_enough_samples(self):
        hybrid = HybridClassifier(min_samples=10)
        hybrid.learned.train(SAMPLES[:5])  # below threshold
        result = hybrid.classify(TaskContext(description="fix a typo in the readme"))
        assert result.tier == Tier.LOCAL
        assert any("not active" in r for r in result.reasons)

    def test_learned_used_after_threshold(self):
        hybrid = HybridClassifier(min_samples=8)
        hybrid.learned.train(SAMPLES)
        result = hybrid.classify(TaskContext(description="fix a typo in the readme"))
        assert result.tier == Tier.LOCAL
        assert any("Learned model" in r for r in result.reasons)

    def test_disagreement_defers_to_heuristics(self):
        # Train on data that teaches the opposite of the heuristic default,
        # then confirm the heuristic tier still wins.
        hybrid = HybridClassifier(min_samples=8)
        inverted = [(d, Tier.FRONTIER if t == Tier.LOCAL else Tier.LOCAL) for d, t in SAMPLES]
        hybrid.learned.train(inverted)

        result = hybrid.classify(
            TaskContext(description="fix a typo in the readme", files_touched=["README.md"])
        )
        # The heuristic says LOCAL; even though the model says FRONTIER, the
        # hybrid keeps LOCAL.
        assert result.tier == Tier.LOCAL
        assert any("overridden by heuristics" in r for r in result.reasons)

    def test_confidence_is_bounded(self):
        hybrid = HybridClassifier(min_samples=8)
        hybrid.learned.train(SAMPLES)
        for description in ("fix a typo", "refactor the architecture"):
            result = hybrid.classify(TaskContext(description=description))
            assert 0.0 <= result.confidence <= 1.0

    def test_agreement_reported(self):
        hybrid = HybridClassifier(min_samples=8)
        hybrid.learned.train(SAMPLES)
        result = hybrid.classify(
            TaskContext(description="refactor the authentication architecture")
        )
        assert any("agreed with heuristics" in r or "overridden" in r for r in result.reasons)


class TestTrainFromFeedback:
    def test_trains_from_feedback_store(self, tmp_path):
        from waypoint.feedback import FeedbackEntry, FeedbackStore

        feedback_path = tmp_path / "feedback.jsonl"
        store = FeedbackStore(str(feedback_path))
        for i, (desc, tier) in enumerate(SAMPLES):
            store.add(
                FeedbackEntry(
                    task_id=f"t{i}",
                    description=desc,
                    predicted_tier="mid",
                    actual_tier=tier.value,
                    was_correct=tier.value == "mid",
                )
            )

        model_path = str(tmp_path / "model.json")
        clf = train_from_feedback(model_path, str(feedback_path), epochs=40)

        assert clf.weights.trained_on == len(SAMPLES)
        assert (tmp_path / "model.json").exists()
        tier, _ = clf.predict("fix a typo in the readme")
        assert tier == Tier.LOCAL

    def test_ignores_entries_without_outcome(self, tmp_path):
        from waypoint.feedback import FeedbackEntry, FeedbackStore

        feedback_path = tmp_path / "feedback.jsonl"
        store = FeedbackStore(str(feedback_path))
        store.add(FeedbackEntry(task_id="t1", description="unlabelled task", predicted_tier="mid"))

        clf = train_from_feedback(str(tmp_path / "m.json"), str(feedback_path))
        assert clf.weights.is_trained() is False
