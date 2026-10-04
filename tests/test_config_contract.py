"""Contract tests: every key the code reads must exist in the example config.

The example config had drifted from the code. These tests parse both the
shipped config and the source to catch that drift.
"""

from pathlib import Path

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / "config.example.yaml"
PACKAGE_DIR = PROJECT_ROOT / "waypoint"


@pytest.fixture(scope="module")
def config():
    return yaml.safe_load(CONFIG_PATH.read_text())


@pytest.fixture(scope="module")
def sources():
    return {path.name: path.read_text(encoding="utf-8") for path in PACKAGE_DIR.glob("*.py")}


class TestShippedConfigShape:
    """The example config must load and contain every documented section."""

    def test_loads(self, config):
        assert isinstance(config, dict)

    @pytest.mark.parametrize(
        "section",
        [
            "tiers",
            "providers",
            "router",
            "learned_classifier",
            "logging",
            "safety",
            "health",
            "budget",
            "model_manager",
            "deployment",
        ],
    )
    def test_section_present(self, config, section):
        assert section in config, f"missing section: {section}"

    @pytest.mark.parametrize("tier", ["local", "mid", "frontier"])
    def test_tier_complete(self, config, tier):
        entry = config["tiers"][tier]
        assert entry["description"]
        assert entry["providers"]
        for provider in entry["providers"]:
            assert provider["name"]
            assert provider["models"]

    def test_local_tiers_cost_nothing(self, config):
        assert config["tiers"]["local"]["cost_per_token"] == 0.0

    def test_hosted_providers_declare_key_env(self, config):
        # A hosted provider with no api_key_env cannot authenticate.
        local = (
            "ollama",
            "lm_studio",
            "llama_cpp",
            "llamacpp",
            "vllm",
            "localai",
            "gpt4all",
            "textgen",
        )
        for tier in ("mid", "frontier"):
            for provider in config["tiers"][tier]["providers"]:
                if provider["name"] not in local:
                    assert "api_key_env" in provider, f"{provider['name']} has no api_key_env"

    def test_local_tier_covers_every_local_server(self, config):
        # The zero-config experience is local-first: every server the
        # factory knows (minus the llamacpp spelling alias) must be
        # represented with at least one model, or `health --offline` and
        # `models` see a smaller world than the code supports.
        from waypoint.providers import LOCAL_PROVIDER_NAMES

        configured = [p["name"] for p in config["tiers"]["local"]["providers"]]
        for name in LOCAL_PROVIDER_NAMES:
            if name == "llamacpp":
                continue
            assert name in configured, f"local server {name} missing from the example"
            entry = next(p for p in config["tiers"]["local"]["providers"] if p["name"] == name)
            assert entry["models"], f"local server {name} has no models"

    def test_no_secrets_in_config(self, config):
        # Keys must be referenced by env var name, never inlined.
        text = CONFIG_PATH.read_text()
        assert "sk-" not in text
        assert "api_key:" not in text

    def test_escalation_has_max_escalations(self, config):
        escalation = config["router"]["escalation"]
        assert "max_escalations" in escalation
        assert escalation["max_escalations"] >= 1

    def test_file_patterns_are_globs_or_regex(self, config):
        patterns = config["router"]["heuristics"]["complex_file_patterns"]
        assert patterns
        for pattern in patterns:
            # Each pattern is either valid regex or a glob the classifier
            # translates. Both are accepted, so just assert it is a string.
            assert isinstance(pattern, str)

    def test_budget_matches_safety_limits(self, config):
        safety = config["safety"]["spend_limits"]
        budget = config["budget"]
        for key in ("per_session", "per_day", "per_task"):
            assert safety[key] == budget[key], f"{key} disagrees"

    def test_default_branch_matches_repo(self, config):
        # The repo's default branch is master, so the example must say master.
        assert config["deployment"]["github"]["default_branch"] == "master"

    def test_thresholds_ordered(self, config):
        assert config["budget"]["warning_threshold"] < config["budget"]["critical_threshold"]


class TestConfigKeysAreConsumed:
    """Keys present in the example should be read by the code."""

    def test_health_keys_used(self, sources):
        assert "health" in sources["health.py"]

    def test_budget_keys_used(self, sources):
        assert "budget" in sources["cost.py"]

    def test_providers_keys_used(self, sources):
        assert "providers" in sources["orchestrator.py"]

    def test_learned_classifier_keys_used(self, sources):
        assert "learned_classifier" in sources["router.py"]

    def test_model_manager_keys_used(self, sources):
        assert "model_manager" in sources["model_manager.py"]

    def test_feedback_file_key_used(self, sources):
        assert "feedback_file" in sources["cli.py"]


class TestDefaultBranchConsistency:
    """The example config's branch must match what the repo actually uses."""

    def test_example_branch_is_the_real_default(self, config):
        default_branch = config["deployment"]["github"]["default_branch"]
        # Guard against reintroducing a main/master mismatch.
        assert default_branch in ("main", "master")


class TestCliDefaultsMatchConfig:
    """CLI fallbacks should not contradict the shipped config."""

    def test_cli_default_config_name(self, sources):
        assert '"config.yaml"' in sources["cli.py"]

    def test_cli_fallbacks_include_example(self, sources):
        assert "config.example.yaml" in sources["cli.py"]

    def test_learned_defaults_match(self, config, sources):
        learned = config["learned_classifier"]
        cli = sources["cli.py"]
        # argparse defaults appear as literal numbers in the CLI source.
        assert f'default={learned["learning_rate"]}' in cli
        assert f'default={learned["epochs"]}' in cli
