"""Tests for CLI argument parsing and dispatch.

Covers a regression where subparser options collided with the parser's own
"command" dest, so "waypoint safety spend" printed help instead of running.
"""

import subprocess
import sys
from pathlib import Path

import pytest

from waypoint.cli import build_parser, main


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args, expect_success=True):
    """Invoke the CLI in a subprocess and return the result."""
    return subprocess.run(
        [sys.executable, "-m", "waypoint", *args],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )


class TestParserDispatch:
    """Every subcommand must be recorded in args.command."""

    @pytest.mark.parametrize("argv", [
        ["route", "--task", "fix a typo"],
        ["run", "--task", "fix a typo"],
        ["health"],
        ["health", "--offline"],
        ["models"],
        ["cost"],
        ["dashboard"],
        ["feedback"],
        ["stats"],
        ["safety", "spend"],
        ["safety", "pending"],
        ["approve"],
        ["approve", "--all"],
        ["deploy", "github", "--github-action", "push"],
        ["train"],
    ])
    def test_subcommand_recorded(self, argv):
        args = build_parser().parse_args(argv)
        assert args.command == argv[0]

    def test_safety_action_parsed(self):
        args = build_parser().parse_args(["safety", "check", "--command", "ls"])
        assert args.safety_action == "check"
        assert args.safety_command == "ls"

    def test_safety_command_does_not_clobber_subcommand(self):
        # A --command option must not overwrite the subcommand name.
        args = build_parser().parse_args(["safety", "check", "--command", "git push"])
        assert args.command == "safety"

    def test_approve_command_does_not_clobber_subcommand(self):
        args = build_parser().parse_args(["approve", "--command", "git push"])
        assert args.command == "approve"
        assert args.approve_command == "git push"

    def test_train_subcommand_survives_its_suppressed_config(self):
        args = build_parser().parse_args(["train"])
        assert args.command == "train"

    def test_no_args_parses_to_no_command(self):
        # main() rejects this by inspecting sys.argv, so the parser alone
        # must not raise.
        args = build_parser().parse_args([])
        assert args.command is None

    def test_no_args_exits_with_help(self):
        result = run_cli()
        assert result.returncode == 1
        assert "usage:" in result.stdout

    def test_help_exits(self):
        with pytest.raises(SystemExit) as exc:
            build_parser().parse_args(["--help"])
        assert exc.value.code == 0


class TestParserOptions:
    def test_route_accepts_context(self):
        args = build_parser().parse_args([
            "route", "--task", "x", "--files", "a.py", "b.py",
            "--error-loops", "2", "--test-failures", "1",
        ])
        assert args.files == ["a.py", "b.py"]
        assert args.error_loops == 2
        assert args.test_failures == 1

    def test_run_accepts_generation_options(self):
        args = build_parser().parse_args([
            "run", "--task", "x", "--temperature", "0.5",
            "--max-tokens", "512", "--stream",
        ])
        assert args.temperature == 0.5
        assert args.max_tokens == 512
        assert args.stream is True

    def test_deploy_rejects_unknown_tool(self):
        with pytest.raises(SystemExit):
            build_parser().parse_args(["deploy", "heroku"])

    def test_train_defaults(self):
        args = build_parser().parse_args(["train"])
        assert args.epochs == 50
        assert args.learning_rate == 0.5


class TestEndToEndCommands:
    """Commands must run, not just parse, against the shipped config."""

    def test_route_runs(self):
        result = run_cli("route", "--task", "Fix a typo in README",
                         "--files", "README.md")
        assert result.returncode == 0, result.stderr
        assert "Tier:" in result.stdout

    def test_route_json_runs(self):
        import json
        result = run_cli("route", "--task", "Refactor the auth architecture",
                         "--files", "a.py", "b.py", "c.py", "--json")
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["tier"] in ("local", "mid", "frontier")

    def test_safety_spend_runs(self):
        # Regression: this printed help because of a dest collision.
        result = run_cli("safety", "spend")
        assert result.returncode == 0, result.stderr
        assert "Session" in result.stdout
        assert "usage:" not in result.stdout

    def test_safety_pending_runs(self):
        result = run_cli("safety", "pending")
        assert result.returncode == 0, result.stderr
        assert "usage:" not in result.stdout

    def test_safety_check_runs(self):
        import json
        result = run_cli("safety", "check", "--command", "git status")
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["command"] == "git status"

    def test_approve_with_no_pending(self):
        result = run_cli("approve")
        assert "No pending approvals" in result.stdout or \
            "Pending approvals" in result.stdout

    def test_stats_runs(self):
        result = run_cli("stats")
        assert result.returncode == 0, result.stderr
        assert "Routed:" in result.stdout

    def test_cost_runs(self):
        result = run_cli("cost")
        assert result.returncode == 0, result.stderr
        assert "Cost:" in result.stdout

    def test_models_runs(self):
        result = run_cli("models")
        assert result.returncode == 0, result.stderr
        assert "Providers:" in result.stdout

    def test_dashboard_writes_file(self, tmp_path):
        output = tmp_path / "dash.html"
        result = run_cli("dashboard", "--output", str(output))
        assert result.returncode == 0, result.stderr
        assert output.exists()
        content = output.read_text()
        assert "<html" in content
        assert "Waypoint" in content

    def test_train_without_feedback_fails_cleanly(self, tmp_path):
        result = run_cli("train", "--config", str(tmp_path / "nope.yaml"))
        # Missing config exits non-zero with a message, not a traceback.
        assert result.returncode != 0
        assert "Traceback" not in result.stderr

    def test_health_offline_runs(self):
        result = run_cli("health", "--offline")
        # No local servers running, so unhealthy/degraded, but no traceback.
        assert "Traceback" not in result.stderr
        assert "healthy," in result.stdout