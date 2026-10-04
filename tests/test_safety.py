"""Tests for the safety module."""

from gearvane.safety import ApprovalStatus, SafetyManager


class TestSafetyManager:
    """Test cases for SafetyManager."""

    def setup_method(self):
        self.config = {
            "safety": {
                "require_approval": [
                    "git_push",
                    "git_force_push",
                    "deploy_production",
                ],
                "spend_limits": {
                    "per_session": 10.0,
                    "per_day": 50.0,
                    "per_task": 5.0,
                },
                "sandbox_allowed": [
                    "git status",
                    "git log",
                    "ls",
                    "cat",
                ],
                "blocked_commands": [
                    "rm -rf",
                    "sudo",
                ],
            }
        }
        self.safety = SafetyManager(self.config)

    def test_blocked_command_denied(self):
        result = self.safety.check_command("rm -rf /")
        assert result.status == ApprovalStatus.DENIED

    def test_sandbox_command_auto_approved(self):
        result = self.safety.check_command("git status")
        assert result.status == ApprovalStatus.AUTO_APPROVED

    def test_git_push_requires_approval(self):
        result = self.safety.check_command("git push origin main")
        assert result.status == ApprovalStatus.PENDING

    def test_git_force_push_requires_approval(self):
        result = self.safety.check_command("git push --force origin main")
        assert result.status == ApprovalStatus.PENDING

    def test_spend_within_limits(self):
        # per_task_limit is 5.0, so a single task can spend at most 5.0 even
        # though the session budget is larger.
        assert self.safety.check_spend(5.0, task_id="task-a")
        self.safety.record_spend(5.0, task_id="task-a")
        # Task budget now exhausted.
        assert not self.safety.check_spend(0.1, task_id="task-a")
        # Session budget (10.0) still has room, and a new task resets task spend.
        assert self.safety.check_spend(5.0, task_id="task-b")

    def test_session_limit_blocks(self):
        self.safety.record_spend(5.0, task_id="task-a")
        self.safety.record_spend(5.0, task_id="task-b")
        # Session budget of 10.0 is now exhausted regardless of task scoping.
        assert not self.safety.check_spend(0.1, task_id="task-c")

    def test_per_task_limit_blocks_within_session_budget(self):
        # per_task_limit is 5.0 but the session budget is 10.0. Spending 5.0 on
        # one task must exhaust the task budget even though session budget remains.
        self.safety.record_spend(5.0, task_id="task-a")
        assert not self.safety.check_spend(0.1, task_id="task-a")
        assert self.safety.check_spend(0.1, task_id="task-b")

    def test_per_task_budget_resets_for_new_task(self):
        # Regression: task_spend used to accumulate forever because nothing called
        # reset_task(), so one expensive task blocked all later tasks.
        self.safety.record_spend(5.0, task_id="task-a")
        self.assertBlockedForCurrentTask()
        # A new task gets a fresh per-task budget.
        assert self.safety.check_spend(5.0, task_id="task-b")
        self.safety.record_spend(5.0, task_id="task-b")
        # Session budget (10.0) is now exhausted.
        assert not self.safety.check_spend(0.1, task_id="task-c")

    def assertBlockedForCurrentTask(self):
        assert not self.safety.check_spend(0.01, task_id="task-a")

    def test_spend_tracker_status(self):
        self.safety.record_spend(2.5)
        status = self.safety.get_spend_status()
        assert status["session_spend"] == 2.5
        assert status["session_remaining"] == 7.5

    def test_pending_approvals_listed(self):
        self.safety.check_command("git push origin main")
        self.safety.check_command("git push --force origin main")

        pending = self.safety.get_pending_approvals()
        assert len(pending) == 2

    def test_approve_operation(self):
        result = self.safety.check_command("git push origin main")
        assert result.status == ApprovalStatus.PENDING

        self.safety.approve(result)
        assert result.status == ApprovalStatus.APPROVED

    def test_deny_operation(self):
        result = self.safety.check_command("git push origin main")
        self.safety.deny(result)
        assert result.status == ApprovalStatus.DENIED

    def test_dry_run_execution(self):
        result = self.safety.execute_sandboxed("git status", dry_run=True)
        assert result["executed"]
        assert "DRY RUN" in result["output"]

    def test_blocked_execution(self):
        result = self.safety.execute_sandboxed("rm -rf /", dry_run=False)
        assert not result["executed"]
        assert "denied" in result["error"].lower()
