"""Tests for the tier router."""

import pytest
from waypoint.classifier import TaskContext, Tier
from waypoint.router import TierRouter


class TestTierRouter:
    """Test cases for TierRouter."""

    def setup_method(self):
        self.config = {
            "tiers": {
                "local": {
                    "description": "Local models",
                    "providers": [
                        {
                            "name": "ollama",
                            "models": ["llama3.2"],
                            "base_url": "http://localhost:11434",
                        }
                    ],
                    "max_retries": 2,
                    "cost_per_token": 0,
                },
                "mid": {
                    "description": "Mid-tier models",
                    "providers": [
                        {
                            "name": "openrouter",
                            "models": ["anthropic/claude-3-haiku"],
                        }
                    ],
                    "max_retries": 2,
                    "cost_per_token": 0.0001,
                },
                "frontier": {
                    "description": "Frontier models",
                    "providers": [
                        {
                            "name": "anthropic",
                            "models": ["claude-sonnet-4-20250514"],
                        }
                    ],
                    "max_retries": 3,
                    "cost_per_token": 0.005,
                },
            },
            "router": {
                "default_tier": "mid",
                "escalation": {
                    "enabled": True,
                    "max_attempts_per_tier": 2,
                    "auto_promote_on_failure": True,
                },
                "manual_override": None,
            },
        }
        self.router = TierRouter(self.config)

    def test_simple_task_routes_to_local(self):
        context = TaskContext(
            description="Fix a typo in README",
            files_touched=["README.md"],
        )
        decision = self.router.route("task-1", context)
        assert decision.tier == Tier.LOCAL
        assert decision.provider.name == "ollama"

    def test_complex_task_routes_to_frontier(self):
        context = TaskContext(
            description="Refactor the authentication architecture",
            files_touched=["src/auth/login.py", "src/auth/oauth.py", "src/auth/session.py"],
        )
        decision = self.router.route("task-2", context)
        assert decision.tier == Tier.FRONTIER

    def test_manual_override_bare_model_name(self):
        config = {**self.config, "router": {**self.config["router"],
                                           "manual_override": "claude-sonnet-4-20250514"}}
        router = TierRouter(config)

        context = TaskContext(description="Fix a typo", files_touched=["README.md"])
        decision = router.route("task-3", context)
        assert decision.model == "claude-sonnet-4-20250514"
        assert decision.tier == Tier.FRONTIER
        assert decision.confidence == 1.0

    def test_manual_override_provider_qualified(self):
        config = {**self.config, "router": {**self.config["router"],
                                           "manual_override": "anthropic/claude-sonnet-4-20250514"}}
        router = TierRouter(config)

        context = TaskContext(description="Fix a typo", files_touched=["README.md"])
        decision = router.route("task-4", context)
        assert decision.model == "claude-sonnet-4-20250514"
        assert decision.provider.name == "anthropic"

    def test_manual_override_slash_in_model_name(self):
        # OpenRouter-style names contain slashes, e.g. anthropic/claude-3-haiku.
        config = {**self.config, "router": {**self.config["router"],
                                           "manual_override": "openrouter/anthropic/claude-3-haiku"}}
        router = TierRouter(config)

        context = TaskContext(description="Fix a typo", files_touched=["README.md"])
        decision = router.route("task-4b", context)
        assert decision.model == "anthropic/claude-3-haiku"
        assert decision.provider.name == "openrouter"

    def test_unmatched_manual_override_falls_back_with_warning(self, caplog):
        config = {**self.config, "router": {**self.config["router"],
                                           "manual_override": "does-not-exist"}}
        router = TierRouter(config)

        context = TaskContext(description="Fix a typo", files_touched=["README.md"])
        decision = router.route("task-3b", context)

        # Must not silently claim the override was honoured.
        assert decision.tier == Tier.LOCAL
        assert "Manual override" not in decision.reasons
        assert any("matched no configured model" in r.message
                   for r in caplog.records if r.levelname == "WARNING")

    def test_escalation_after_failures(self):
        context = TaskContext(
            description="Fix the bug",
            files_touched=["src/bug.py"],
        )
        
        # First attempt - should go to local
        decision1 = self.router.route("task-4", context)
        assert decision1.tier == Tier.LOCAL
        
        # Report failures
        self.router.report_failure("task-4")
        self.router.report_failure("task-4")
        
        # Second attempt - should escalate
        decision2 = self.router.route("task-4", context)
        assert decision2.escalated
        assert decision2.tier == Tier.MID

    def test_success_resets_failures(self):
        context = TaskContext(
            description="Fix the bug",
            files_touched=["src/bug.py"],
        )
        
        self.router.route("task-5", context)
        self.router.report_failure("task-5")
        self.router.report_success("task-5")
        
        # Should not escalate
        decision = self.router.route("task-5", context)
        assert not decision.escalated

    def test_fallback_to_default_tier(self):
        config = self.config.copy()
        config["router"]["default_tier"] = "mid"
        router = TierRouter(config)
        
        # Remove local tier to force fallback
        del config["tiers"]["local"]
        router = TierRouter(config)
        
        context = TaskContext(
            description="Fix a typo",
            files_touched=["README.md"],
        )
        decision = router.route("task-6", context)
        assert decision.tier == Tier.MID

    def test_task_history_tracked(self):
        context = TaskContext(
            description="Fix a typo",
            files_touched=["README.md"],
        )
        self.router.route("task-7", context)
        
        history = self.router.get_task_history("task-7")
        assert history is not None
        assert history["attempts"] == 1
