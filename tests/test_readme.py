"""Tests that the root README stays accurate.

Updated for the monorepo README, which describes the TypeScript engine, the
apps, and the site rather than listing every Python module.
"""

import re
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
README_PATH = PROJECT_ROOT / "README.md"


@pytest.fixture(scope="module")
def readme():
    return README_PATH.read_text(encoding="utf-8")


class TestDocumentedCommandsExist:
    """Every command named in the README must be a real command."""

    @pytest.mark.parametrize(
        "command",
        ["waypoint route", "waypoint run", "waypoint safety spend", "waypoint deploy"],
    )
    def test_command_documented(self, command, readme):
        assert command in readme

    def test_python_cli_implements_the_documented_commands(self, readme):
        for command in ["route", "run", "health", "models", "cost", "safety", "deploy"]:
            assert command in readme, f"{command} undocumented"

    def test_python_cli_help_lists_them(self):
        help_text = subprocess.run(
            [sys.executable, "-m", "waypoint", "--help"],
            capture_output=True,
            text=True,
            timeout=120,
        ).stdout

        for command in ["route", "run", "health", "models", "cost", "safety", "deploy"]:
            assert command in help_text

    def test_typescript_cli_implements_the_documented_commands(self):
        cli = PROJECT_ROOT / "packages" / "cli" / "dist" / "bin.js"
        if not cli.exists():
            pytest.skip("TypeScript CLI is not built")

        help_text = subprocess.run(
            ["node", str(cli), "--help"],
            capture_output=True,
            text=True,
            timeout=120,
        ).stdout

        for command in ["route", "run", "health", "models", "cost", "safety", "deploy"]:
            assert command in help_text


class TestDocumentedPathsExist:
    """Every path the README points at must exist."""

    @pytest.mark.parametrize(
        "path",
        [
            "packages/core",
            "packages/cli",
            "apps/desktop",
            "apps/vscode-extension",
            "apps/app-core",
            "site",
            "waypoint",
            "SECURITY.md",
            "config.example.yaml",
            "requirements.txt",
            "requirements-dev.txt",
        ],
    )
    def test_path_exists(self, path):
        assert (PROJECT_ROOT / path).exists(), f"README points at missing {path}"

    def test_links_the_build_guide(self, readme):
        assert "apps/desktop/BUILDING.md" in readme
        assert (PROJECT_ROOT / "apps" / "desktop" / "BUILDING.md").exists()


class TestVersionsAgree:
    def test_python_and_typescript_versions_match(self):
        ts_version = _ts_version()
        match = re.search(
            r'__version__ = "([^"]+)"',
            (PROJECT_ROOT / "waypoint" / "__init__.py").read_text(encoding="utf-8"),
        )
        assert match is not None
        assert match.group(1) == ts_version

    def test_setup_py_matches_the_package(self):
        setup = (PROJECT_ROOT / "setup.py").read_text(encoding="utf-8")
        version = re.search(r'version="([^"]+)"', setup)
        assert version is not None
        assert version.group(1) == _ts_version()

    def test_readme_quotes_the_current_vsix_version(self, readme):
        assert f"{_ts_version()}.vsix" in readme


def _ts_version() -> str:
    import json

    pkg = json.loads(
        (PROJECT_ROOT / "packages" / "core" / "package.json").read_text(encoding="utf-8")
    )
    return str(pkg["version"])


class TestReadmeQuality:
    def test_has_licence_section(self, readme):
        assert "## Licence" in readme or "## License" in readme
        assert "MIT" in readme

    def test_has_status_section(self, readme):
        assert "## Status" in readme

    def test_includes_install_instructions(self, readme):
        assert "pip install -r requirements.txt" in readme
        assert "npm install" in readme

    def test_mentions_python_version(self, readme):
        assert "3.9" in readme

    def test_mentions_node_version(self, readme):
        assert "node" in readme.lower()

    def test_no_placeholder_text(self, readme):
        for marker in ("TODO", "FIXME", "XXX", "TBD", "Lorem ipsum"):
            assert marker not in readme, f"placeholder {marker} left in README"

    def test_is_valid_utf8_without_replacement_chars(self, readme):
        # The architecture diagram uses box-drawing characters, which GitHub
        # renders correctly. A replacement character means content was lost.
        assert "\ufffd" not in readme

    def test_has_no_bom(self, readme):
        assert not readme.startswith("\ufeff")


class TestHonestClaims:
    """A README that overstates the project is worse than none."""

    def test_states_the_project_is_alpha(self, readme):
        assert "alpha" in readme.lower()

    def test_qualifies_the_learned_classifier(self, readme):
        assert "not** been evaluated" in readme or "not been evaluated" in readme

    def test_discloses_unsigned_binaries(self, readme):
        assert "unsigned" in readme.lower()

    def test_discloses_the_absence_of_sandboxing(self, readme):
        assert "does not sandbox" in readme

    def test_links_the_security_policy(self, readme):
        assert "SECURITY.md" in readme


class TestNoSecrets:
    def test_embeds_no_api_key(self, readme):
        assert "sk-ant-" not in readme
        assert "sk-or-" not in readme

    def test_embeds_no_github_token(self, readme):
        assert "ghp_" not in readme
        assert "github_pat_" not in readme

    def test_api_keys_are_shown_as_placeholders(self, readme):
        if "ANTHROPIC_API_KEY" in readme:
            line = next(line for line in readme.splitlines() if "ANTHROPIC_API_KEY=" in line)
            assert "..." in line or "<" in line, "key example should be a placeholder"
