"""Tests for the safety module."""

import pytest
from waypoint.safety import SafetyManager, ApprovalStatus


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
        assert self.safety.check_spend(5.0)
        self.safety.record_spend(5.0)
        assert self.safety.check_spend(4.0)
        assert not self.safety.check_spend(6.0)

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
