"""Tests for the task classifier."""

from gearvane.classifier import TaskClassifier, TaskContext, Tier


class TestTaskClassifier:
    """Test cases for TaskClassifier."""

    def setup_method(self):
        self.classifier = TaskClassifier()

    def test_simple_task_classifies_as_local(self):
        context = TaskContext(
            description="Fix a typo in the README",
            files_touched=["README.md"],
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.LOCAL
        assert result.confidence > 0.5

    def test_complex_task_classifies_as_frontier(self):
        context = TaskContext(
            description="Refactor the authentication system to use OAuth2",
            files_touched=["src/auth/login.py", "src/auth/oauth.py", "src/auth/session.py"],
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.FRONTIER

    def test_default_to_mid_when_no_signals(self):
        context = TaskContext(
            description="Update the thing",
            files_touched=[],
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.MID

    def test_error_loops_increase_tier(self):
        context = TaskContext(
            description="Fix the bug",
            files_touched=["src/bug.py"],
            error_loops=3,
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.FRONTIER

    def test_test_failures_increase_tier(self):
        context = TaskContext(
            description="Fix tests",
            files_touched=["tests/test_foo.py"],
            test_failures=5,
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.FRONTIER

    def test_many_files_increases_complexity(self):
        context = TaskContext(
            description="Update code",
            files_touched=["a.py", "b.py", "c.py", "d.py", "e.py"],
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.FRONTIER

    def test_escalation_from_local(self):
        context = TaskContext(
            description="Fix the thing",
            files_touched=["src/thing.py"],
            previous_tier=Tier.LOCAL,
            previous_attempts=3,
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.MID

    def test_escalation_from_mid(self):
        context = TaskContext(
            description="Fix the thing",
            files_touched=["src/thing.py"],
            previous_tier=Tier.MID,
            previous_attempts=3,
        )
        result = self.classifier.classify(context)
        assert result.tier == Tier.FRONTIER

    def test_confidence_is_bounded(self):
        context = TaskContext(
            description="Simple fix",
            files_touched=["README.md"],
        )
        result = self.classifier.classify(context)
        assert 0.0 <= result.confidence <= 1.0

    def test_reasons_are_populated(self):
        context = TaskContext(
            description="Fix a typo in documentation",
            files_touched=["README.md"],
        )
        result = self.classifier.classify(context)
        assert len(result.reasons) > 0
