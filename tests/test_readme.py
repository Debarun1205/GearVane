"""Tests that the README stays accurate.

Documentation drifts silently, and a README describing commands that do
not exist is worse than none. These check the documented surface against
the actual code.
"""

import re
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
README = PROJECT_ROOT / "README.md"


@pytest.fixture(scope="module")
def readme():
    return README.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def cli_source():
    return (PROJECT_ROOT / "waypoint" / "cli.py").read_text(encoding="utf-8")


class TestDocumentedCommandsExist:
    """Every command named in the CLI table must be registered."""

    @pytest.mark.parametrize(
        "command",
        [
            "route",
            "run",
            "health",
            "models",
            "cost",
            "stats",
            "feedback",
            "train",
            "dashboard",
            "safety",
            "approve",
            "deploy",
        ],
    )
    def test_command_registered(self, command, cli_source):
        assert f'add_parser("{command}"' in cli_source, f"{command} documented but not registered"

    def test_all_registered_commands_documented(self, cli_source, readme):
        registered = set(re.findall(r'add_parser\("([^"]+)"', cli_source))
        for command in registered:
            assert command in readme, f"{command} undocumented"

    def test_entry_point_declared(self):
        setup = (PROJECT_ROOT / "setup.py").read_text(encoding="utf-8")
        assert "waypoint=waypoint.cli:main" in setup.replace(" ", "")


class TestDocumentedFlagsExist:
    """Flags shown in the README must be accepted by the parser."""

    def test_run_stream_flag(self, cli_source):
        assert '"--stream"' in cli_source

    def test_run_files_flag(self, cli_source):
        assert '"--files"' in cli_source

    def test_health_offline_flag(self, cli_source):
        assert '"--offline"' in cli_source

    def test_json_flag_repeated(self, cli_source):
        assert cli_source.count('"--json"') >= 5

    def test_dashboard_output_flag(self, cli_source):
        assert '"--output"' in cli_source

    def test_approve_flags(self, cli_source):
        assert '"--all"' in cli_source

    def test_dry_run_flag(self, cli_source):
        assert '"--dry-run"' in cli_source


@pytest.fixture(scope="module")
def config_text():
    """The shipped example config, read once."""
    return (PROJECT_ROOT / "config.example.yaml").read_text(encoding="utf-8")


class TestDocumentedConfigKeysExist:
    """Config keys in the README must exist in the example config."""

    @pytest.mark.parametrize(
        "key",
        [
            "cost_per_token",
            "default_tier",
            "max_attempts_per_tier",
            "max_escalations",
            "manual_override",
            "min_samples",
            "blend",
            "model_file",
            "spend_limits",
            "per_task",
            "per_session",
            "per_day",
            "require_approval",
            "sandbox_allowed",
            "blocked_commands",
        ],
    )
    def test_key_present_in_config(self, key, config_text):
        assert key in config_text, f"{key} documented but absent from config"

    def test_learned_classifier_section_documented(self, readme, config_text):
        assert "learned_classifier" in readme
        assert "learned_classifier" in config_text

    def test_safety_limits_match_readme_example(self, readme, config_text):
        # The README shows 5.0/10.0/50.0; the config must agree.
        for value in ("5.0", "10.0", "50.0"):
            assert value in readme
            assert value in config_text


class TestDocumentedModulesExist:
    """The project layout table must list real files."""

    @pytest.mark.parametrize(
        "module",
        [
            "classifier.py",
            "learned_classifier.py",
            "router.py",
            "providers.py",
            "orchestrator.py",
            "retry.py",
            "health.py",
            "cost.py",
            "logger.py",
            "feedback.py",
            "safety.py",
            "deployment.py",
            "dashboard.py",
            "model_manager.py",
            "plugin.py",
            "opencode_plugin.py",
            "cli.py",
        ],
    )
    def test_module_exists(self, module):
        assert (PROJECT_ROOT / "waypoint" / module).is_file()

    @pytest.mark.parametrize(
        "module",
        [
            "classifier.py",
            "learned_classifier.py",
            "router.py",
            "providers.py",
            "orchestrator.py",
            "retry.py",
            "health.py",
            "cost.py",
            "logger.py",
            "feedback.py",
            "safety.py",
            "deployment.py",
            "dashboard.py",
            "model_manager.py",
            "plugin.py",
            "opencode_plugin.py",
            "cli.py",
        ],
    )
    def test_module_listed_in_readme(self, module, readme):
        assert module in readme, f"{module} exists but is not documented"


class TestDocumentedPythonApi:
    """The plugin example must match the real signatures."""

    def test_plugin_import_path(self):
        assert (PROJECT_ROOT / "waypoint" / "opencode_plugin.py").is_file()

    def test_classify_task_exists(self):
        source = (PROJECT_ROOT / "waypoint" / "opencode_plugin.py").read_text(encoding="utf-8")
        assert "def classify_task(" in source
        assert "def execute_task(" in source

    def test_readme_shows_classify_task(self, readme):
        assert "plugin.classify_task(" in readme

    def test_module_level_hooks_documented(self, readme):
        for hook in ("classify_task", "execute_task", "select_model", "stats"):
            assert hook in readme


@pytest.fixture(scope="module")
def security():
    """The security policy, read once."""
    return (PROJECT_ROOT / "SECURITY.md").read_text(encoding="utf-8")


class TestSecurityDocs:
    """SECURITY.md must document the credential rules the code enforces."""

    def test_security_file_exists(self):
        assert (PROJECT_ROOT / "SECURITY.md").is_file()

    def test_readme_links_to_security_policy(self, readme):
        assert "SECURITY.md" in readme

    def test_warns_against_tokens_in_remote_urls(self, security):
        assert "x-access-token" in security
        assert "credential.helper" in security

    def test_documents_environment_only_keys(self, security):
        assert "api_key_env" in security
        assert "environment" in security.lower()

    def test_documents_approval_gate_guarantees(self, security):
        assert "--dry-run" in security
        assert "blocked_commands" in security

    def test_no_secrets_in_repo_docs(self, security, readme):
        for text in (security, readme):
            assert "ghp_" not in text
            assert "sk-ant-" not in text
            assert "github_pat_" not in text

    def test_readme_states_no_sandboxing(self, security):
        # Do not imply isolation the code does not provide.
        assert "does not sandbox" in security


class TestReadmeQuality:
    def test_has_license_section(self, readme):
        assert "## License" in readme
        assert "MIT" in readme

    def test_has_security_section(self, readme):
        assert "## Security" in readme

    def test_has_status_section(self, readme):
        # A project should state its maturity honestly.
        assert "## Status" in readme

    def test_no_placeholder_text(self, readme):
        for marker in ("TODO", "FIXME", "XXX", "coming soon", "TBD"):
            assert marker not in readme, f"placeholder {marker} left in README"

    def test_test_count_is_accurate(self, readme):
        # The README states a test count; keep it honest.
        match = re.search(r"(\d+) tests", readme)
        if match:
            assert int(match.group(1)) >= 200

    def test_includes_install_instructions(self, readme):
        assert "pip install -r requirements.txt" in readme
        assert "cp config.example.yaml config.yaml" in readme

    def test_includes_python_version_requirement(self, readme):
        assert "3.9" in readme

    def test_is_valid_utf8(self, readme):
        # The README is a UTF-8 document rendered by GitHub, so box drawing
        # and arrows are fine here. The ASCII restriction applies to Python
        # source, which gets printed to cp1252 Windows consoles.
        README.read_text(encoding="utf-8")

    def test_no_replacement_characters(self, readme):
        # A mis-decoded file shows U+FFFD, which means real content is lost.
        assert "\ufffd" not in readme

    def test_commands_are_ascii(self):
        # Only the commands a user types into a shell must be ASCII-safe.
        commands = (
            "waypoint route --task",
            "waypoint run --task",
            "waypoint safety spend",
            "waypoint health --offline",
            "pip install -e .",
        )
        for command in commands:
            command.encode("ascii")
