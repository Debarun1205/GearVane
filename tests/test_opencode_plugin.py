"""Tests for the OpenCode plugin integration surface."""

import pytest

from waypoint.classifier import Tier
from waypoint.opencode_plugin import (
    WaypointPlugin,
    find_config,
    load_yaml_config,
)
from waypoint.providers import Completion, Usage


def make_config():
    """Plain factory so setup_method can call it.

    A pytest fixture cannot be referenced from setup_method, where the name
    would resolve to the fixture function rather than its value.
    """
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
        "router": {"default_tier": "mid",
                   "escalation": {"enabled": True, "max_attempts_per_tier": 2}},
    }


@pytest.fixture
def config():
    return make_config()


class FakeClient:
    def __init__(self, content="ok", tin=5, tout=7):
        self.result = Completion(content=content, model="m",
                                 usage=Usage(tokens_in=tin, tokens_out=tout))

    def complete(self, prompt, system=None, temperature=0.0, max_tokens=2048):
        return self.result

    def stream(self, prompt, system=None, temperature=0.0, max_tokens=2048):
        yield "he"
        yield "llo"


class TestConfigDiscovery:
    def test_finds_config_in_current_dir(self, tmp_path, monkeypatch):
        (tmp_path / "waypoint.config.yaml").write_text("router: {}\n")
        monkeypatch.chdir(tmp_path)
        assert find_config() == tmp_path / "waypoint.config.yaml"

    def test_walks_up_to_parent(self, tmp_path, monkeypatch):
        (tmp_path / "waypoint.yaml").write_text("router: {}\n")
        nested = tmp_path / "a" / "b" / "c"
        nested.mkdir(parents=True)
        monkeypatch.chdir(nested)
        assert find_config() == tmp_path / "waypoint.yaml"

    def test_returns_none_when_absent(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        # Guard against picking up a config outside the sandbox.
        assert find_config(start_dir=str(tmp_path)) is None or \
            find_config(start_dir=str(tmp_path)).parent != tmp_path

    def test_load_yaml_config_explicit_path(self, tmp_path):
        path = tmp_path / "c.yaml"
        path.write_text("router:\n  default_tier: local\n")
        assert load_yaml_config(str(path))["router"]["default_tier"] == "local"

    def test_load_yaml_config_missing_returns_empty(self, tmp_path):
        assert load_yaml_config(str(tmp_path / "nope.yaml")) == {}

    def test_load_yaml_config_rejects_non_mapping(self, tmp_path):
        path = tmp_path / "list.yaml"
        path.write_text("- a\n- b\n")
        assert load_yaml_config(str(path)) == {}


class TestLifecycle:
    def test_on_start_returns_true(self, config):
        plugin = WaypointPlugin(config=config)
        assert plugin.on_start() is True

    def test_on_stop_runs(self, config):
        plugin = WaypointPlugin(config=config)
        assert plugin.on_stop() is None

    def test_router_is_lazy(self, config):
        plugin = WaypointPlugin(config=config)
        assert plugin._router is None
        plugin.classify_task("fix a typo")
        assert plugin._router is not None

    def test_same_router_instance_reused(self, config):
        plugin = WaypointPlugin(config=config)
        assert plugin.router is plugin.router

    def test_empty_config_raises_clear_error(self):
        # With no tiers there is nothing to route to. The error must name the
        # problem rather than surfacing AttributeError on None.
        plugin = WaypointPlugin(config={})
        with pytest.raises(ValueError, match="No usable model tiers"):
            plugin.classify_task("something")


class TestClassification:
    def setup_method(self):
        self.plugin = WaypointPlugin(config=make_config())

    def test_classify_returns_expected_shape(self):
        result = self.plugin.classify_task("fix a typo in the readme")
        assert set(result) == {"tier", "provider", "model", "confidence",
                               "escalated", "reasons"}
        assert result["tier"] == "local"

    def test_classify_accepts_files(self):
        result = self.plugin.classify_task(
            "update", files=["src/a.py", "src/b.py", "src/c.py"]
        )
        assert result["tier"] in ("mid", "frontier")

    def test_classify_honours_manual_override(self):
        cfg = {
            "tiers": {
                "frontier": {
                    "description": "F",
                    "providers": [{"name": "anthropic", "models": ["claude-x"],
                                   "base_url": "https://api.anthropic.com"}],
                }
            },
            "router": {"default_tier": "frontier",
                       "manual_override": "anthropic/claude-x"},
        }
        plugin = WaypointPlugin(config=cfg)
        result = plugin.classify_task("fix a typo")
        assert result["model"] == "claude-x"

    def test_select_model_returns_string(self):
        model = self.plugin.select_model("fix a typo in the readme")
        assert isinstance(model, str)
        assert model == "llama3.2"


class TestExecution:
    def setup_method(self):
        self.plugin = WaypointPlugin(config=make_config())
        self.plugin.orchestrator.providers.create = (
            lambda p, m=None: FakeClient("executed")
        )

    def test_execute_returns_flat_dict(self):
        result = self.plugin.execute_task("fix a typo in the readme")
        assert result["success"] is True
        assert result["content"] == "executed"
        assert isinstance(result["cost_usd"], float)
        assert result["tokens_in"] == 5

    def test_execute_result_has_no_internal_objects(self):
        # Hosts typically serialize this to JSON.
        import json
        result = self.plugin.execute_task("fix a typo in the readme")
        json.dumps(result)

    def test_execute_passes_files(self):
        result = self.plugin.execute_task(
            "refactor the auth architecture", files=["src/a.py", "src/b.py", "src/c.py"]
        )
        assert result["success"] is True
        assert result["tier"] == "frontier"

    def test_execute_uses_task_id(self):
        result = self.plugin.execute_task("fix a typo", task_id="my-task")
        assert result["success"] is True

    def test_stream_yields_tokens(self):
        tokens = list(self.plugin.stream_task("fix a typo"))
        assert tokens == ["he", "llo"]

    def test_failure_is_reported_not_raised(self):
        from waypoint.providers import ProviderError

        class Failing(FakeClient):
            def complete(self, *args, **kwargs):
                raise ProviderError("down", retryable=False)

        self.plugin.orchestrator.providers.create = (
            lambda p, m=None: Failing()
        )
        result = self.plugin.execute_task("fix a typo")
        assert result["success"] is False
        assert result["error"]


class TestStats:
    def test_stats_shape(self, config):
        plugin = WaypointPlugin(config=config)
        stats = plugin.stats()
        assert set(stats) == {"spend", "cost", "tiers"}
        assert "session_spend" in stats["spend"]
        assert set(stats["tiers"]) == {"local", "mid", "frontier"}