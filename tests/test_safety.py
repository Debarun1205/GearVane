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

    def test_no_spend_limit_ever_blocks(self):
        # R4: no usage or spend limit is enforced on the user, for any model.
        # The old tracker refused a run past a per-task ceiling, and the default
        # ceiling of $5 was enforced as though the user had chosen it.
        self.safety.record_spend(5.0, task_id="task-a")
        self.safety.record_spend(5.0, task_id="task-b")
        # Far past any former ceiling, and it still permits.
        assert self.safety.check_spend(10_000.0, task_id="task-c")

    def test_spend_is_recorded_per_task(self):
        # Recording still happens, and it still scopes to the current task.
        self.safety.record_spend(5.0, task_id="task-a")
        self.safety.record_spend(2.0, task_id="task-b")
        status = self.safety.get_spend_status()
        assert status["session_spend"] == 7.0
        assert status["task_spend"] == 2.0

    def test_spend_status_reports_no_limits(self):
        # No `*_remaining` key, because there is no budget to remain within.
        self.safety.record_spend(2.5)
        status = self.safety.get_spend_status()
        assert status["session_spend"] == 2.5
        assert status["limits"] == "none"
        assert status["enforced"] is False
        assert "session_remaining" not in status
        assert "task_remaining" not in status

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
