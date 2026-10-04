"""Tests for the remaining untested modules: cost, feedback, health, logger,
dashboard, model_manager, deployment, plugin, and streaming.

These modules shipped in the initial commits without any tests.
"""

import json

import pytest

from gearvane.classifier import Tier
from gearvane.cost import AlertLevel, CostTracker
from gearvane.dashboard import DashboardGenerator
from gearvane.deployment import (
    CloudflareDeployer,
    DeploymentManager,
    DeployResult,
    DockerDeployer,
    FlyioDeployer,
    GitHubDeployer,
    VercelDeployer,
)
from gearvane.feedback import FeedbackEntry, FeedbackLoop, FeedbackStore
from gearvane.health import HealthStatus, ModelHealthChecker
from gearvane.logger import RoutingLogger
from gearvane.plugin import GearVanePlugin, PluginManager, PluginMetadata
from gearvane.router import ModelProvider, RoutingDecision
from gearvane.safety import SafetyManager

# --------------------------------------------------------------------------
# cost
# --------------------------------------------------------------------------


class TestCostTracker:
    def test_records_usage(self):
        tracker = CostTracker()
        tracker.record_usage("t1", "mid", "haiku", 1000, 500, 0.0001)
        stats = tracker.get_stats()
        assert stats["total_calls"] == 1
        assert stats["total_tokens_in"] == 1000
        assert stats["total_tokens_out"] == 500
        assert stats["total_cost_usd"] == pytest.approx(0.15)

    def test_cost_by_tier_and_model(self):
        tracker = CostTracker()
        tracker.record_usage("t1", "local", "llama", 100, 100, 0.0)
        tracker.record_usage("t2", "frontier", "claude", 100, 100, 0.01)
        stats = tracker.get_stats()
        assert stats["cost_by_tier"]["frontier"] == pytest.approx(2.0)
        assert stats["cost_by_tier"]["local"] == pytest.approx(0.0)
        assert stats["cost_by_model"]["claude"] == pytest.approx(2.0)

    def test_empty_stats(self):
        assert CostTracker().get_stats()["total_calls"] == 0

    def test_warning_alert_fires(self):
        tracker = CostTracker(per_session=1.0, warning_threshold=0.5, critical_threshold=0.9)
        alerts = []
        tracker.add_alert_handler(alerts.append)
        tracker.record_usage("t1", "mid", "m", 100, 100, 0.004)
        assert alerts
        assert alerts[0].level == AlertLevel.WARNING

    def test_critical_alert_fires(self):
        tracker = CostTracker(per_session=1.0, warning_threshold=0.5, critical_threshold=0.8)
        alerts = []
        tracker.add_alert_handler(alerts.append)
        tracker.record_usage("t1", "mid", "m", 1000, 1000, 0.001)
        levels = [a.level for a in alerts]
        assert AlertLevel.CRITICAL in levels

    def test_alerts_do_not_repeat_at_same_level(self):
        tracker = CostTracker(per_session=1.0, warning_threshold=0.1, critical_threshold=0.95)
        alerts = []
        tracker.add_alert_handler(alerts.append)
        for _ in range(5):
            tracker.record_usage("t", "mid", "m", 10, 10, 0.001)
        warnings = [a for a in alerts if a.level == AlertLevel.WARNING]
        assert len(warnings) == 1

    def test_handler_exception_does_not_break_tracking(self):
        tracker = CostTracker(per_session=1.0, warning_threshold=0.1)

        def bad_handler(alert):
            raise RuntimeError("handler broke")

        tracker.add_alert_handler(bad_handler)
        tracker.record_usage("t", "mid", "m", 100, 100, 0.001)
        assert tracker.get_stats()["total_calls"] == 1

    def test_get_task_spend(self):
        tracker = CostTracker()
        tracker.record_usage("t1", "mid", "m", 100, 100, 0.001)
        tracker.record_usage("t2", "mid", "m", 100, 100, 0.001)
        assert tracker.get_task_spend("t1") == pytest.approx(0.2)

    def test_reset_session_clears(self):
        tracker = CostTracker()
        tracker.record_usage("t", "mid", "m", 10, 10, 0.01)
        tracker.reset_session()
        assert tracker.get_stats()["total_calls"] == 0


# --------------------------------------------------------------------------
# feedback
# --------------------------------------------------------------------------


class TestFeedback:
    @pytest.fixture
    def store(self, tmp_path):
        return FeedbackStore(str(tmp_path / "feedback.jsonl"))

    def test_add_and_retrieve(self, store):
        store.add(FeedbackEntry(task_id="t1", description="a task", predicted_tier="mid"))
        assert len(store.get_entries()) == 1

    def test_persists_to_disk(self, tmp_path):
        path = tmp_path / "feedback.jsonl"
        store = FeedbackStore(str(path))
        store.add(FeedbackEntry(task_id="t1", description="x", predicted_tier="mid"))
        assert path.exists()
        reloaded = FeedbackStore(str(path))
        assert len(reloaded.get_entries()) == 1

    def test_empty_stats(self, store):
        stats = store.get_stats()
        assert stats["total_entries"] == 0
        assert stats["accuracy"] == 0

    def test_accuracy_computed(self, store):
        store.add(FeedbackEntry("t1", "x", "mid", "mid", True))
        store.add(FeedbackEntry("t2", "y", "mid", "frontier", False))
        stats = store.get_stats()
        assert stats["correct_predictions"] == 1
        assert stats["accuracy"] == pytest.approx(0.5)

    def test_by_tier_stats(self, store):
        store.add(FeedbackEntry("t1", "x", "mid", "mid", True))
        store.add(FeedbackEntry("t2", "y", "mid", "local", False))
        stats = store.get_stats()
        assert stats["by_tier"]["mid"]["total"] == 2
        assert stats["by_tier"]["mid"]["correct"] == 1

    def test_record_outcome_updates_entry(self, store):
        loop = FeedbackLoop(store)
        loop.record_prediction("t1", "a task", "mid")
        loop.record_outcome("t1", "mid")
        entry = store.get_entries()[0]
        assert entry.actual_tier == "mid"
        assert entry.was_correct is True

    def test_record_misclassification(self, store):
        loop = FeedbackLoop(store)
        loop.record_prediction("t1", "a task", "local")
        loop.record_outcome("t1", "frontier")
        assert store.get_entries()[0].was_correct is False

    def test_low_accuracy_suggestion(self, store):
        loop = FeedbackLoop(store)
        for i in range(6):
            loop.record_prediction(f"t{i}", f"task {i}", "mid")
            loop.record_outcome(f"t{i}", "frontier")
        suggestions = loop.get_adjustment_suggestions()
        assert any(s["type"] == "low_accuracy" for s in suggestions)

    def test_training_data_only_includes_labelled(self, store):
        loop = FeedbackLoop(store)
        loop.record_prediction("t1", "labelled", "mid")
        loop.record_outcome("t1", "frontier")
        loop.record_prediction("t2", "unlabelled", "mid")
        data = loop.get_training_data()
        assert len(data) == 1
        assert data[0]["tier"] == "frontier"

    def test_export_feedback(self, store, tmp_path):
        loop = FeedbackLoop(store)
        loop.record_prediction("t1", "a task", "mid")
        out = tmp_path / "export.json"
        loop.export_feedback(str(out))
        assert len(json.loads(out.read_text())) == 1


# --------------------------------------------------------------------------
# health
# --------------------------------------------------------------------------


class TestHealthChecker:
    def test_probe_success(self):
        import asyncio

        checker = ModelHealthChecker()
        checker.register_model("m1", "ollama", probe=lambda: True)
        result = asyncio.run(checker.check_model("m1"))
        assert result.status == HealthStatus.HEALTHY

    def test_probe_failure_is_degraded_first(self):
        import asyncio

        checker = ModelHealthChecker(failure_threshold=3)
        checker.register_model("m1", "ollama", probe=lambda: False)
        result = asyncio.run(checker.check_model("m1"))
        assert result.status == HealthStatus.DEGRADED

    def test_repeated_failures_become_unhealthy(self):
        import asyncio

        checker = ModelHealthChecker(failure_threshold=2)
        checker.register_model("m1", "ollama", probe=lambda: False)
        asyncio.run(checker.check_model("m1"))
        result = asyncio.run(checker.check_model("m1"))
        assert result.status == HealthStatus.UNHEALTHY

    def test_success_resets_failure_count(self):
        import asyncio

        checker = ModelHealthChecker(failure_threshold=2)
        state = {"fail": True}

        def probe():
            return not state["fail"]

        checker.register_model("m1", "ollama", probe=probe)
        asyncio.run(checker.check_model("m1"))
        state["fail"] = False
        asyncio.run(checker.check_model("m1"))
        state["fail"] = True
        result = asyncio.run(checker.check_model("m1"))
        assert result.status == HealthStatus.DEGRADED

    def test_no_probe_reports_unknown(self):
        import asyncio

        checker = ModelHealthChecker()
        checker.register_model("m1", "ollama")
        result = asyncio.run(checker.check_model("m1"))
        assert result.status == HealthStatus.UNKNOWN

    def test_unregistered_model(self):
        import asyncio

        result = asyncio.run(ModelHealthChecker().check_model("nope"))
        assert result.status == HealthStatus.UNKNOWN

    def test_high_latency_degrades(self):
        import asyncio
        import time

        checker = ModelHealthChecker(latency_threshold_ms=1)

        def slow_probe():
            time.sleep(0.01)
            return True

        checker.register_model("m1", "ollama", probe=slow_probe)
        result = asyncio.run(checker.check_model("m1"))
        assert result.status == HealthStatus.DEGRADED
        assert "latency" in result.message.lower()

    def test_status_change_callback(self):
        import asyncio

        events = []
        checker = ModelHealthChecker(failure_threshold=1)
        checker.add_status_callback(lambda model, old, new: events.append((model, old, new)))
        checker.register_model("m1", "ollama", probe=lambda: True)
        asyncio.run(checker.check_model("m1"))
        checker._results["m1"].status = HealthStatus.HEALTHY
        checker.register_model("m1", "ollama", probe=lambda: False)
        asyncio.run(checker.check_model("m1"))
        assert events

    def test_healthy_and_unhealthy_lists(self):
        import asyncio

        checker = ModelHealthChecker(failure_threshold=1)
        checker.register_model("good", "ollama", probe=lambda: True)
        checker.register_model("bad", "ollama", probe=lambda: False)
        asyncio.run(checker.check_all())
        assert checker.get_healthy_models() == ["good"]
        assert checker.get_unhealthy_models() == ["bad"]

    def test_probe_exception_marks_unhealthy(self):
        import asyncio

        checker = ModelHealthChecker(failure_threshold=1)

        def boom():
            raise RuntimeError("probe exploded")

        checker.register_model("m1", "ollama", probe=boom)
        result = asyncio.run(checker.check_model("m1"))
        assert result.status == HealthStatus.UNHEALTHY


# --------------------------------------------------------------------------
# logger
# --------------------------------------------------------------------------


class TestRoutingLogger:
    def make_decision(self, tier=Tier.MID, escalated=False):
        return RoutingDecision(
            tier=tier,
            provider=ModelProvider(name="openrouter", models=["haiku"]),
            model="haiku",
            confidence=0.8,
            reasons=["test"],
            escalated=escalated,
            attempt=1,
        )

    def test_log_routing_records_entry(self):
        logger = RoutingLogger({"enabled": False})
        logger.log_routing("t1", self.make_decision())
        assert logger.get_stats()["total"] == 1

    def test_log_outcome_updates_entry(self):
        logger = RoutingLogger({"enabled": False})
        logger.log_routing("t1", self.make_decision())
        logger.log_outcome("t1", True, cost_usd=0.5)
        stats = logger.get_stats()
        assert stats["successes"] == 1
        assert stats["total_cost_usd"] == pytest.approx(0.5)

    def test_failure_recorded(self):
        logger = RoutingLogger({"enabled": False})
        logger.log_routing("t1", self.make_decision())
        logger.log_outcome("t1", False)
        assert logger.get_stats()["failures"] == 1

    def test_tier_distribution(self):
        logger = RoutingLogger({"enabled": False})
        logger.log_routing("t1", self.make_decision(Tier.LOCAL))
        logger.log_routing("t2", self.make_decision(Tier.FRONTIER))
        dist = logger.get_stats()["tier_distribution"]
        assert dist["local"] == 1
        assert dist["frontier"] == 1

    def test_escalations_counted(self):
        logger = RoutingLogger({"enabled": False})
        logger.log_routing("t1", self.make_decision(escalated=True))
        assert logger.get_stats()["escalations"] == 1

    def test_export_json(self, tmp_path):
        logger = RoutingLogger({"enabled": False})
        logger.log_routing("t1", self.make_decision())
        out = tmp_path / "log.json"
        logger.export_json(str(out))
        assert len(json.loads(out.read_text())) == 1

    def test_disabled_logger_records_nothing(self):
        logger = RoutingLogger({"enabled": False, "log_routing_decisions": False})
        logger.log_routing("t1", self.make_decision())
        assert logger.get_stats()["total"] == 0


# --------------------------------------------------------------------------
# dashboard
# --------------------------------------------------------------------------


class TestDashboard:
    def make_dashboard(self):
        logger = RoutingLogger({"enabled": False})
        logger.log_routing(
            "t1",
            RoutingDecision(
                tier=Tier.MID,
                provider=ModelProvider(name="openrouter", models=["haiku"]),
                model="haiku",
                confidence=0.8,
                reasons=["test"],
            ),
        )
        logger.log_outcome("t1", True, cost_usd=0.25)
        return DashboardGenerator(logger, CostTracker({"enabled": False}))

    def test_generates_html(self):
        html = self.make_dashboard().generate()
        assert "<html" in html
        assert "GearVane Dashboard" in html

    def test_no_unreplaced_placeholders(self):
        html = self.make_dashboard().generate()
        assert "{{" not in html
        assert "}}" not in html

    def test_shows_tier_distribution(self):
        html = self.make_dashboard().generate()
        assert html.count("MID") >= 1

    def test_is_ascii_safe(self):
        # Windows consoles use cp1252; the old emoji status broke this.
        html = self.make_dashboard().generate()
        offenders = {c for c in html if ord(c) > 127}
        assert not offenders, f"non-ascii: {offenders}"

    def test_save_writes_file(self, tmp_path):
        out = tmp_path / "d.html"
        self.make_dashboard().save(str(out))
        assert out.exists()
        assert "<html" in out.read_text()

    def test_handles_no_data(self):
        dashboard = DashboardGenerator(
            RoutingLogger({"enabled": False}), CostTracker({"enabled": False})
        )
        html = dashboard.generate()
        assert "<html" in html
        assert "{{" not in html


# --------------------------------------------------------------------------
# deployment
# --------------------------------------------------------------------------


class TestDeploymentGating:
    @pytest.fixture
    def config(self):
        return {
            "safety": {
                "require_approval": ["git_push", "git_force_push", "deploy_production"],
                "spend_limits": {"per_session": 10.0, "per_day": 50.0, "per_task": 5.0},
                "sandbox_allowed": ["git status", "git log"],
                "blocked_commands": ["rm -rf", "sudo"],
            },
            "deployment": {
                "github": {"enabled": True, "default_branch": "master"},
                "docker": {"enabled": True},
                "flyio": {"enabled": True},
                "vercel": {"enabled": True},
                "cloudflare": {"enabled": True},
            },
        }

    def test_github_push_requires_approval(self, config):
        manager = DeploymentManager(config)
        result = manager.github.push(dry_run=True)
        assert result.approval_required is True
        assert result.success is False

    def test_github_status_is_allowed(self, config):
        manager = DeploymentManager(config)
        result = manager.github.get_status()
        # git status is in the sandbox allowlist.
        assert result.approval_required is False

    def test_dry_run_does_not_execute_gated_command(self, config):
        # A gated command returns an approval prompt rather than running.
        manager = DeploymentManager(config)
        result = manager.github.push(branch="master", dry_run=True)
        assert result.approval_required is True
        assert "DRY RUN" not in result.output

    def test_allowlisted_command_is_not_gated(self, config):
        # git status is allowlisted, so it runs without approval.
        manager = DeploymentManager(config)
        result = manager.github.get_status()
        assert result.approval_required is False

    def test_force_push_requires_approval(self, config):
        manager = DeploymentManager(config)
        # Force push is classified separately and is always gated.
        approval = manager.safety.check_command("git push --force origin master")
        assert approval.status.value == "pending"

    def test_docker_build_allowed(self, config):
        manager = DeploymentManager(config)
        result = manager.docker.build(tag="test:latest", dry_run=True)
        assert result.success is True
        assert "DRY RUN" in result.output

    def test_flyio_deploy_requires_approval(self, config):
        manager = DeploymentManager(config)
        result = manager.flyio.deploy(app="myapp", dry_run=True)
        assert result.approval_required is True

    def test_vercel_prod_requires_approval(self, config):
        manager = DeploymentManager(config)
        result = manager.vercel.deploy(prod=True, dry_run=True)
        assert result.approval_required is True

    def test_cloudflare_deploy_requires_approval(self, config):
        manager = DeploymentManager(config)
        result = manager.cloudflare.deploy(dry_run=True)
        assert result.approval_required is True

    def test_pending_approvals_listed(self, config):
        manager = DeploymentManager(config)
        manager.github.push(dry_run=True)
        pending = manager.get_pending_approvals()
        assert len(pending) >= 1
        assert "operation" in pending[0]

    def test_approve_operation(self, config):
        manager = DeploymentManager(config)
        manager.github.push(branch="master", dry_run=True)
        pending = manager.get_pending_approvals()
        assert pending
        command = pending[0]["command"]
        assert manager.approve_operation(command) is True

    def test_approve_unknown_command_returns_false(self, config):
        manager = DeploymentManager(config)
        assert manager.approve_operation("not a pending command") is False

    def test_disabled_tool_is_none(self):
        config = {
            "safety": {"require_approval": [], "blocked_commands": []},
            "deployment": {"github": {"enabled": False}},
        }
        manager = DeploymentManager(config)
        assert manager.github is None

    def test_deploy_result_message_defaults(self):
        # message is optional; constructing without it must not raise.
        result = DeployResult(success=True, tool="github")
        assert result.message == ""

    def test_deployers_construct_independently(self, config):
        safety = SafetyManager(config)
        assert isinstance(GitHubDeployer(safety, {}), GitHubDeployer)
        assert isinstance(DockerDeployer(safety, {}), DockerDeployer)
        assert isinstance(FlyioDeployer(safety, {}), FlyioDeployer)
        assert isinstance(VercelDeployer(safety, {}), VercelDeployer)
        assert isinstance(CloudflareDeployer(safety, {}), CloudflareDeployer)


# --------------------------------------------------------------------------
# plugin
# --------------------------------------------------------------------------


class DummyPlugin(GearVanePlugin):
    name = "dummy"

    def __init__(self):
        self.metadata = PluginMetadata(
            name="dummy",
            version="1.0",
            description="test plugin",
            author="test",
            hooks=["on_route", "on_failure"],
        )
        self.events = []
        self.shutdown_called = False

    def initialize(self, config):
        # Honour the caller's config so failure can be exercised.
        return not config.get("fail_init", False)

    def shutdown(self):
        self.shutdown_called = True

    def on_route(self, task_id, context, decision):
        self.events.append(("route", task_id))

    def on_failure(self, task_id, error):
        self.events.append(("failure", error))


class TestPluginManager:
    def test_register_and_initialize(self):
        manager = PluginManager()
        assert manager.register(DummyPlugin, {}) is True
        assert len(manager.list_plugins()) == 1

    def test_failed_initialization_is_rejected(self):
        manager = PluginManager()
        assert manager.register(DummyPlugin, {"fail_init": True}) is False
        assert manager.list_plugins() == []

    def test_unregister_calls_shutdown(self):
        manager = PluginManager()
        manager.register(DummyPlugin, {})
        plugin = manager.get_plugin("dummy")
        assert manager.unregister("dummy") is True
        assert plugin.shutdown_called is True

    def test_unregister_unknown_returns_false(self):
        assert PluginManager().unregister("nope") is False

    def test_hooks_are_dispatched(self):
        manager = PluginManager()
        manager.register(DummyPlugin, {})
        manager.emit_hook("on_route", "t1", None, None)
        assert ("route", "t1") in manager.get_plugin("dummy").events

    def test_unregistered_hook_is_ignored(self):
        manager = PluginManager()
        manager.register(DummyPlugin, {})
        manager.emit_hook("on_escalation", "t1", "local", "mid")

    def test_hook_exception_does_not_propagate(self):
        class Exploding(DummyPlugin):
            def on_route(self, task_id, context, decision):
                raise RuntimeError("hook broke")

        manager = PluginManager()
        manager.register(Exploding, {})
        manager.emit_hook("on_route", "t1", None, None)

    def test_unregister_removes_hooks(self):
        manager = PluginManager()
        manager.register(DummyPlugin, {})
        manager.unregister("dummy")
        manager.emit_hook("on_route", "t1", None, None)

    def test_get_plugin_by_name(self):
        manager = PluginManager()
        manager.register(DummyPlugin, {})
        assert manager.get_plugin("dummy") is not None
        assert manager.get_plugin("missing") is None

    def test_load_from_bad_module(self):
        manager = PluginManager()
        assert manager.load_from_module("nonexistent.module", {}) is False


# --------------------------------------------------------------------------
# streaming (event plumbing, not the deprecated mock client)
# --------------------------------------------------------------------------


class TestStreamingEvents:
    def test_event_serializes(self):
        from gearvane.streaming import StreamEvent, StreamEventType

        event = StreamEvent(type=StreamEventType.TOKEN, data={"token": "hi"})
        payload = event.to_dict()
        assert payload["type"] == "token"
        assert json.loads(event.to_json())["data"]["token"] == "hi"

    def test_buffer_dispatches_to_handler(self):
        from gearvane.streaming import StreamBuffer, StreamEvent, StreamEventType

        received = []
        buffer = StreamBuffer()
        buffer.on(StreamEventType.TOKEN, received.append)
        buffer.emit(StreamEvent(type=StreamEventType.TOKEN, data="x"))
        assert len(received) == 1

    def test_buffer_respects_max_size(self):
        from gearvane.streaming import StreamBuffer, StreamEvent, StreamEventType

        buffer = StreamBuffer(buffer_size=3)
        for _ in range(10):
            buffer.emit(StreamEvent(type=StreamEventType.TOKEN, data="x"))
        assert len(buffer.get_recent(100)) == 3

    def test_buffer_handler_exception_is_contained(self):
        from gearvane.streaming import StreamBuffer, StreamEvent, StreamEventType

        buffer = StreamBuffer()

        def bad(event):
            raise RuntimeError("handler broke")

        buffer.on(StreamEventType.TOKEN, bad)
        buffer.emit(StreamEvent(type=StreamEventType.TOKEN, data="x"))

    def test_buffer_clear(self):
        from gearvane.streaming import StreamBuffer, StreamEvent, StreamEventType

        buffer = StreamBuffer()
        buffer.emit(StreamEvent(type=StreamEventType.TOKEN, data="x"))
        buffer.clear()
        assert buffer.get_recent() == []
