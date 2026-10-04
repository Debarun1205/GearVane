"""Tests for feedback recording in `gearvane run`.

Covers the gap where record_prediction/record_outcome had no callers: every
non-stream run must leave a prediction behind, and every successful run must
close it with the tier that served the request, so `gearvane train` has
labelled data to learn from.
"""

import argparse
import json
from pathlib import Path

import pytest

from gearvane import cli as cli_module
from gearvane.orchestrator import ExecutionResult


class FakeOrchestrator:
    """Stand-in for Orchestrator returning a canned result."""

    def __init__(self, config, result):
        self.config = config
        self._result = result

    def execute(self, *args, **kwargs):
        return self._result


def make_args(config_path, **overrides):
    base = {
        "config": str(config_path),
        "task_id": "t1",
        "task": "fix a typo in the readme",
        "files": [],
        "system": None,
        "temperature": 0.0,
        "max_tokens": 64,
        "error_loops": 0,
        "test_failures": 0,
        "stream": False,
        "json": False,
    }
    base.update(overrides)
    return argparse.Namespace(**base)


def write_config(path, feedback_path):
    # Forward slashes: a Windows path in double quotes would turn \t and \U
    # into YAML escapes. Both engines accept forward slashes on Windows.
    safe = str(feedback_path).replace("\\", "/")
    path.write_text(f'logging:\n  feedback_file: "{safe}"\n', encoding="utf-8")


def read_entries(feedback_path):
    return [json.loads(line) for line in Path(feedback_path).read_text().splitlines()]


def test_run_records_first_try_success(tmp_path, monkeypatch, capsys):
    feedback_path = tmp_path / "feedback.jsonl"
    config_path = tmp_path / "config.yaml"
    write_config(config_path, feedback_path)

    result = ExecutionResult(
        task_id="t1",
        success=True,
        tier="local",
        history=[{"attempt": 1, "tier": "local", "model": "qwen2.5-coder", "success": True}],
    )
    monkeypatch.setattr(cli_module, "Orchestrator", lambda config: FakeOrchestrator(config, result))

    cli_module.cmd_run(make_args(config_path))

    (entry,) = read_entries(feedback_path)
    assert entry["task_id"] == "t1"
    assert entry["description"] == "fix a typo in the readme"
    assert entry["predicted_tier"] == "local"
    assert entry["actual_tier"] == "local"
    assert entry["was_correct"] is True


def test_run_records_escalation_as_miss(tmp_path, monkeypatch, capsys):
    """The prediction is the router's first pick, not the serving tier."""
    feedback_path = tmp_path / "feedback.jsonl"
    config_path = tmp_path / "config.yaml"
    write_config(config_path, feedback_path)

    result = ExecutionResult(
        task_id="t2",
        success=True,
        tier="mid",
        history=[
            {"attempt": 1, "tier": "local", "model": "qwen2.5-coder", "success": False},
            {"attempt": 2, "tier": "mid", "model": "muse-spark-1.3", "success": True},
        ],
    )
    monkeypatch.setattr(cli_module, "Orchestrator", lambda config: FakeOrchestrator(config, result))

    cli_module.cmd_run(make_args(config_path, task_id="t2"))

    (entry,) = read_entries(feedback_path)
    assert entry["predicted_tier"] == "local"
    assert entry["actual_tier"] == "mid"
    assert entry["was_correct"] is False


def test_failed_run_records_prediction_without_outcome(tmp_path, monkeypatch, capsys):
    """A failed run leaves the prediction open; it must never enter training."""
    feedback_path = tmp_path / "feedback.jsonl"
    config_path = tmp_path / "config.yaml"
    write_config(config_path, feedback_path)

    result = ExecutionResult(
        task_id="t3",
        success=False,
        tier="frontier",
        history=[{"attempt": 1, "tier": "local", "success": False}],
        error="all providers down",
    )
    monkeypatch.setattr(cli_module, "Orchestrator", lambda config: FakeOrchestrator(config, result))

    with pytest.raises(SystemExit) as exc:
        cli_module.cmd_run(make_args(config_path, task_id="t3"))
    assert exc.value.code == 1

    (entry,) = read_entries(feedback_path)
    assert entry["predicted_tier"] == "local"
    assert entry["actual_tier"] is None
    assert entry["was_correct"] is None


def test_feedback_write_failure_does_not_break_run(tmp_path, monkeypatch, capsys):
    """A feedback path that cannot be written must not fail a good run."""
    config_path = tmp_path / "config.yaml"
    # feedback_file points at a directory, so opening it for writing raises.
    write_config(config_path, tmp_path)

    result = ExecutionResult(task_id="t4", success=True, tier="local", history=[])
    monkeypatch.setattr(cli_module, "Orchestrator", lambda config: FakeOrchestrator(config, result))

    # No exception escapes; a successful run returns normally.
    cli_module.cmd_run(make_args(config_path, task_id="t4"))


def test_empty_history_falls_back_to_result_tier(tmp_path, monkeypatch, capsys):
    """Budget-gate rejections have no attempts; the decision tier still counts."""
    feedback_path = tmp_path / "feedback.jsonl"
    config_path = tmp_path / "config.yaml"
    write_config(config_path, feedback_path)

    result = ExecutionResult(task_id="t5", success=False, tier="mid", history=[])
    monkeypatch.setattr(cli_module, "Orchestrator", lambda config: FakeOrchestrator(config, result))

    with pytest.raises(SystemExit):
        cli_module.cmd_run(make_args(config_path, task_id="t5"))

    (entry,) = read_entries(feedback_path)
    assert entry["predicted_tier"] == "mid"
    assert entry["actual_tier"] is None
