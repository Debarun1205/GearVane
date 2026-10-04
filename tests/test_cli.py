"""Tests for the CLI, focused on config loading and glob pattern handling.

These cover regressions that only appear when the shipped example config is
used, which the unit tests for individual modules did not exercise.
"""

import pytest

from gearvane.classifier import TaskClassifier, TaskContext, Tier
from gearvane.cli import load_config


class TestConfigLoading:
    """Config discovery and validation."""

    def test_falls_back_to_example_config(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "config.example.yaml").write_text("tiers: {}\n")

        config = load_config("config.yaml")
        assert config == {"tiers": {}}
        assert "config.example.yaml" in capsys.readouterr().err

    def test_explicit_path_wins(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "custom.yaml").write_text("router:\n  default_tier: local\n")
        (tmp_path / "config.example.yaml").write_text("router:\n  default_tier: mid\n")

        config = load_config("custom.yaml")
        assert config["router"]["default_tier"] == "local"

    def test_missing_config_exits(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        with pytest.raises(SystemExit):
            load_config("nope.yaml")

    def test_empty_config_is_dict(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "config.yaml").write_text("")
        assert load_config("config.yaml") == {}

    def test_non_mapping_config_exits(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "config.yaml").write_text("- just\n- a\n- list\n")
        with pytest.raises(SystemExit):
            load_config("config.yaml")


class TestShippedExampleConfig:
    """The example config must actually work end to end."""

    @pytest.fixture
    def example_config(self):
        from pathlib import Path

        path = Path(__file__).resolve().parent.parent / "config.example.yaml"
        return load_config(str(path))

    def test_loads_without_error(self, example_config):
        assert isinstance(example_config, dict)
        assert "tiers" in example_config

    def test_file_patterns_compile(self, example_config):
        # The shipped config uses globs like "*.rs", which are not valid regex.
        classifier = TaskClassifier(example_config.get("router", {}))
        assert classifier.complex_file_patterns

    def test_classification_works_with_shipped_patterns(self, example_config):
        classifier = TaskClassifier(example_config.get("router", {}))
        result = classifier.classify(
            TaskContext(description="fix something", files_touched=["README.md"])
        )
        assert isinstance(result.tier, Tier)

    def test_all_tiers_have_providers(self, example_config):
        for tier in ("local", "mid", "frontier"):
            providers = example_config["tiers"][tier]["providers"]
            assert providers, f"tier {tier} has no providers"


class TestGlobPatternTranslation:
    """Glob patterns from config must be translated, not used as regex."""

    def test_glob_matches_nested_path(self):
        classifier = TaskClassifier({"heuristics": {"complex_file_patterns": ["*.rs"]}})
        # "*.rs" should match a file in a subdirectory.
        result = classifier.classify(
            TaskContext(description="update", files_touched=["src/main.rs"])
        )
        assert (
            "complex file patterns" in " ".join(result.reasons).lower()
            or result.scores["frontier"] > 0
        )

    def test_glob_with_suffix(self):
        classifier = TaskClassifier({"heuristics": {"complex_file_patterns": ["*_test.*"]}})
        result = classifier.classify(
            TaskContext(description="update", files_touched=["src/parser_test.go"])
        )
        assert result.scores["frontier"] > 0

    def test_suffix_glob_does_not_match_prefixed_name(self):
        # "*_test.*" requires "_test." mid-name, so a file named
        # "test_foo.py" does not match. Documented so the shipped config's
        # behaviour is not mistaken for a bug.
        classifier = TaskClassifier({"heuristics": {"complex_file_patterns": ["*_test.*"]}})
        result = classifier.classify(
            TaskContext(description="update", files_touched=["src/test_foo.py"])
        )
        assert result.scores["frontier"] == 0

    def test_regex_patterns_still_work(self):
        classifier = TaskClassifier({"heuristics": {"complex_file_patterns": [r"\.go$"]}})
        result = classifier.classify(TaskContext(description="update", files_touched=["main.go"]))
        assert result.scores["frontier"] > 0

    def test_invalid_regex_falls_back_to_glob(self):
        # A bare "+" is invalid regex but a valid glob.
        classifier = TaskClassifier({"heuristics": {"complex_file_patterns": ["+"]}})
        assert classifier.complex_file_patterns == ["\\+"]

    def test_default_patterns_are_valid(self):
        classifier = TaskClassifier()
        result = classifier.classify(
            TaskContext(description="x", files_touched=["src/core/engine.py"])
        )
        assert isinstance(result.tier, Tier)
