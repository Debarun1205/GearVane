"""Tests for the end-to-end orchestrator."""

import pytest

from waypoint.cost import CostTracker
from waypoint.orchestrator import (
    NonRetryableError,
    Orchestrator,
    RetryableProviderError,
)
from waypoint.providers import Completion, ProviderError, Usage


def make_config(per_task=5.0, per_session=50.0, max_retries=0, retry_delay=0.0):
    return {
        "tiers": {
            "local": {
                "description": "Local",
                "providers": [{"name": "ollama", "models": ["llama3.2"],
                               "base_url": "http://localhost:11434"}],
                "cost_per_token": 0.0,
            },
            "mid": {
                "description": "Mid",
                "providers": [{"name": "openrouter", "models": ["haiku"],
                               "base_url": "https://openrouter.ai/api"}],
                "cost_per_token": 0.0,
            },
            "frontier": {
                "description": "Frontier",
                "providers": [{"name": "anthropic", "models": ["claude-x"],
                               "base_url": "https://api.anthropic.com"}],
                "cost_per_token": 0.0,
            },
        },
        "router": {
            "default_tier": "mid",
            "escalation": {"enabled": True, "max_attempts_per_tier": 2,
                           "max_escalations": 2},
        },
        "providers": {"max_retries": max_retries, "retry_base_delay": retry_delay,
                      "retry_max_delay": retry_delay},
        "safety": {
            "require_approval": [],
            "spend_limits": {"per_session": per_session, "per_day": per_session,
                             "per_task": per_task},
            "blocked_commands": [],
            "sandbox_allowed": [],
        },
    }


class FakeClient:
    """Stands in for a ProviderClient."""

    def __init__(self, results):
        # results is a list of Completion or Exception
        self.results = list(results)
        self.calls = []

    def complete(self, prompt, system=None, temperature=0.0, max_tokens=2048):
        self.calls.append({"prompt": prompt, "system": system,
                           "temperature": temperature, "max_tokens": max_tokens})
        if not self.results:
            raise AssertionError("FakeClient called more times than expected")
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def stream(self, prompt, system=None, temperature=0.0, max_tokens=2048):
        for token in ["a ", "b ", "c"]:
            yield token


def ok(content="done", tin=10, tout=20):
    return Completion(content=content, model="m",
                      usage=Usage(tokens_in=tin, tokens_out=tout))


class TestExecuteSuccess:
    """Happy path routing and execution."""

    def setup_method(self):
        self.orch = Orchestrator(make_config())

    def test_returns_completion(self):
        self.orch.providers.create = lambda p, m=None: FakeClient([ok("hello")])
        result = self.orch.execute("t1", "fix a typo")
        assert result.success is True
        assert result.content == "hello"
        assert result.attempts == 1

    def test_routes_simple_task_to_local(self):
        self.orch.providers.create = lambda p, m=None: FakeClient([ok()])
        result = self.orch.execute("t1", "fix a typo in README",
                                   files_touched=["README.md"])
        assert result.tier == "local"
        assert result.provider == "ollama"

    def test_routes_complex_task_to_frontier(self):
        self.orch.providers.create = lambda p, m=None: FakeClient([ok()])
        result = self.orch.execute(
            "t2", "refactor the authentication architecture for scale",
            files_touched=["src/auth/a.py", "src/auth/b.py", "src/auth/c.py"],
        )
        assert result.tier == "frontier"

    def test_records_cost_from_tier_rate(self):
        config = make_config(per_task=100.0, per_session=100.0)
        config["tiers"]["frontier"]["cost_per_token"] = 0.01
        orch = Orchestrator(config)
        orch.providers.create = lambda p, m=None: FakeClient([ok(tin=100, tout=200)])
        result = orch.execute(
            "t3", "refactor the architecture for concurrency at scale",
            files_touched=["a.py", "b.py", "c.py"],
        )
        # 300 tokens at 0.01/token
        assert result.cost_usd == pytest.approx(3.0)
        assert result.tokens_in == 100
        assert result.tokens_out == 200

    def test_history_records_success(self):
        self.orch.providers.create = lambda p, m=None: FakeClient([ok()])
        result = self.orch.execute("t4", "fix a typo")
        assert len(result.history) == 1
        assert result.history[0]["success"] is True
        assert result.history[0]["attempt"] == 1

    def test_passes_system_and_temperature_through(self):
        fake = FakeClient([ok()])
        self.orch.providers.create = lambda p, m=None: fake
        self.orch.execute("t5", "fix a typo", system="be brief", temperature=0.3)
        assert fake.calls[0]["system"] == "be brief"
        assert fake.calls[0]["temperature"] == 0.3


class TestEscalation:
    """Failure handling and tier promotion."""

    def setup_method(self):
        self.orch = Orchestrator(make_config())

    def test_failure_escalates_to_higher_tier(self):
        clients = []

        def create(p, m=None):
            clients.append(FakeClient([ProviderError("boom", retryable=False)]))
            return clients[-1]

        self.orch.providers.create = create
        # Force a complex task that starts at frontier, with no tier above it.
        result = self.orch.execute(
            "t1", "refactor architecture for scale and concurrency",
            files_touched=["a.py", "b.py", "c.py"],
        )
        assert result.success is False
        # Stays on frontier because there is no higher tier, but all attempts ran.
        assert result.attempts == 3
        assert len(result.history) == 3
        assert all(h["success"] is False for h in result.history)

    def test_recovers_on_later_attempt(self):
        attempts = []

        def create(p, m=None):
            attempts.append(1)
            if len(attempts) == 1:
                return FakeClient([ProviderError("transient", retryable=False)])
            return FakeClient([ok("recovered")])

        self.orch.providers.create = create
        result = self.orch.execute("t2", "fix a typo in README")
        assert result.success is True
        assert result.content == "recovered"
        assert result.attempts == 2
        assert result.history[0]["success"] is False
        assert result.history[1]["success"] is True

    def test_single_failure_does_not_escalate(self):
        # max_attempts_per_tier is 2, so one failure retries the same tier.
        calls = []

        def create(p, m=None):
            calls.append(p.name)
            if len(calls) == 1:
                return FakeClient([ProviderError("boom", retryable=False)])
            return FakeClient([ok()])

        self.orch.providers.create = create
        result = self.orch.execute("t3", "fix a typo in README",
                                   files_touched=["README.md"])
        assert result.success is True
        assert calls == ["ollama", "ollama"]
        assert result.escalated is False

    def test_escalates_after_max_attempts_per_tier(self):
        config = make_config()
        config["router"]["escalation"]["max_attempts_per_tier"] = 1
        orch = Orchestrator(config)
        calls = []

        def create(p, m=None):
            calls.append(p.name)
            if len(calls) == 1:
                return FakeClient([ProviderError("boom", retryable=False)])
            return FakeClient([ok()])

        orch.providers.create = create
        result = orch.execute("t4", "fix a typo in README",
                              files_touched=["README.md"])
        assert result.success is True
        # First attempt local, second promoted to mid.
        assert calls[0] == "ollama"
        assert calls[1] == "openrouter"
        assert result.escalated is True

    def test_all_failures_reported(self):
        def create(p, m=None):
            return FakeClient([ProviderError("always fails", retryable=False)])

        self.orch.providers.create = create
        result = self.orch.execute("t4", "fix a typo")
        assert result.success is False
        assert result.error == "All attempts failed"
        assert result.content == ""


class TestBudgetGate:
    """Spend is checked before tokens are spent."""

    def test_blocks_when_over_budget(self):
        # Local models are free, so they pass any budget. Charge the local tier
        # to exercise the gate.
        config = make_config(per_task=0.01, per_session=0.01)
        config["tiers"]["local"]["cost_per_token"] = 0.01
        orch = Orchestrator(config)
        called = []
        orch.providers.create = lambda p, m=None: called.append(1) or FakeClient([ok()])
        result = orch.execute("t1", "fix a typo")
        assert result.success is False
        assert "Budget exceeded" in result.error
        # No provider call should have been made.
        assert called == []

    def test_frontier_estimate_blocks_when_local_would_pass(self):
        config = make_config(per_task=5.0, per_session=1000.0)
        config["tiers"]["frontier"]["cost_per_token"] = 0.01
        orch = Orchestrator(config)
        orch.providers.create = lambda p, m=None: FakeClient([ok()])
        # max_tokens default 2048 * 0.01 = 20.48 > per_task 5.0
        result = orch.execute("t1", "refactor architecture for scale",
                              files_touched=["a.py", "b.py", "c.py"])
        assert result.success is False
        assert "Budget exceeded" in result.error

    def test_zero_cost_local_passes_tight_budget(self):
        orch = Orchestrator(make_config(per_task=0.0, per_session=0.0))
        orch.providers.create = lambda p, m=None: FakeClient([ok()])
        result = orch.execute("t1", "fix a typo", files_touched=["README.md"])
        # Local tier costs nothing, so it is allowed through.
        assert result.success is True


class TestRetryIntegration:
    """Only transient failures are retried."""

    def test_retries_retryable_errors(self):
        calls = []

        def create(p, m=None):
            fake = FakeClient([
                ProviderError("timeout", retryable=True),
                ok("ok after retry"),
            ])
            calls.append(fake)
            return fake

        orch = Orchestrator(make_config(max_retries=2, retry_delay=0.0))
        orch.providers.create = create
        result = orch.execute("t1", "fix a typo")
        assert result.success is True
        # The retry happened inside one orchestrator attempt.
        assert len(calls[0].calls) == 2

    def test_does_not_retry_permanent_errors(self):
        orch = Orchestrator(make_config(max_retries=3, retry_delay=0.0))
        # One result per orchestrator attempt, so exhausting this fake proves
        # the retry loop did not call complete() more than once per attempt.
        results = [ProviderError("bad request", retryable=False)] * 4
        fake = FakeClient(results)
        orch.providers.create = lambda p, m=None: fake
        result = orch.execute("t2", "fix a typo")
        assert result.success is False
        # max_retries=3 would mean 4 complete() calls per attempt if permanent
        # errors were retried. Each orchestrator attempt must call it once.
        orchestrator_attempts = len(result.history)
        assert len(fake.calls) == orchestrator_attempts
        assert orchestrator_attempts < 4


class TestStream:
    def test_stream_yields_tokens(self):
        orch = Orchestrator(make_config())
        orch.providers.create = lambda p, m=None: FakeClient([ok()])
        tokens = list(orch.execute_stream("t1", "fix a typo"))
        assert tokens == ["a ", "b ", "c"]