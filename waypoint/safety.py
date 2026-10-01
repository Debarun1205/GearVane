"""Safety module: approval gates, spend limits, and sandboxing."""

import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Set, Dict, Any
from pathlib import Path


class ApprovalStatus(Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    AUTO_APPROVED = "auto_approved"


@dataclass
class ApprovalRequest:
    operation: str
    command: str
    reason: str
    status: ApprovalStatus = ApprovalStatus.PENDING
    timestamp: float = field(default_factory=time.time)
    approved_by: Optional[str] = None


@dataclass
class SpendTracker:
    """Track spending against limits."""
    per_session_limit: float = 10.0
    per_day_limit: float = 50.0
    per_task_limit: float = 5.0
    
    session_spend: float = 0.0
    day_spend: float = 0.0
    task_spend: float = 0.0
    _session_start: float = field(default_factory=time.time)
    _day_start: float = field(default_factory=time.time)
    _current_task_id: Optional[str] = None

    def start_task(self, task_id: str):
        """Begin tracking a new task and reset the per-task budget.

        Per-task spend must reset when the task changes. Previously this was
        only resettable via an explicit reset_task() call that no caller made,
        so once task_spend hit per_task_limit every later task was blocked for
        the life of the process.
        """
        if self._current_task_id != task_id:
            self.task_spend = 0.0
            self._current_task_id = task_id

    def can_spend(self, amount: float) -> bool:
        """Check if a spend amount is within limits."""
        if self.session_spend + amount > self.per_session_limit:
            return False
        if self.day_spend + amount > self.per_day_limit:
            return False
        if self.task_spend + amount > self.per_task_limit:
            return False
        return True

    def record_spend(self, amount: float, task_id: Optional[str] = None):
        """Record a spend, scoping it to a task."""
        if task_id is not None:
            self.start_task(task_id)
        self.session_spend += amount
        self.day_spend += amount
        self.task_spend += amount

    def reset_task(self):
        """Reset per-task spend."""
        self.task_spend = 0.0
        self._current_task_id = None

    def get_status(self) -> Dict[str, Any]:
        """Get current spend status."""
        return {
            "session_spend": round(self.session_spend, 4),
            "day_spend": round(self.day_spend, 4),
            "task_spend": round(self.task_spend, 4),
            "session_remaining": round(self.per_session_limit - self.session_spend, 4),
            "day_remaining": round(self.per_day_limit - self.day_spend, 4),
            "task_remaining": round(self.per_task_limit - self.task_spend, 4),
        }


class SafetyManager:
    """Manages safety: approvals, spend limits, and sandboxing."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        safety_config = self.config.get("safety", {})
        
        # Approval settings
        self.require_approval: Set[str] = set(
            safety_config.get("require_approval", [])
        )
        
        # Spend limits
        spend_config = safety_config.get("spend_limits", {})
        self.spend_tracker = SpendTracker(
            per_session_limit=spend_config.get("per_session", 10.0),
            per_day_limit=spend_config.get("per_day", 50.0),
            per_task_limit=spend_config.get("per_task", 5.0),
        )
        
        # Sandbox settings
        self.sandbox_allowed: List[str] = safety_config.get("sandbox_allowed", [])
        self.blocked_commands: List[str] = safety_config.get("blocked_commands", [])
        
        # Pending approvals
        self._pending_approvals: List[ApprovalRequest] = []

    def check_command(self, command: str) -> ApprovalRequest:
        """Check if a command needs approval."""
        # Check blocked commands first
        for blocked in self.blocked_commands:
            if blocked in command:
                return ApprovalRequest(
                    operation="blocked",
                    command=command,
                    reason=f"Command contains blocked pattern: {blocked}",
                    status=ApprovalStatus.DENIED,
                )

        # Check if command is in sandbox allowed list
        for allowed in self.sandbox_allowed:
            if command.strip().startswith(allowed):
                return ApprovalRequest(
                    operation="sandbox",
                    command=command,
                    reason="Command is in sandbox allowlist",
                    status=ApprovalStatus.AUTO_APPROVED,
                )

        # Check if operation type requires approval
        operation = self._classify_operation(command)
        if operation in self.require_approval:
            req = ApprovalRequest(
                operation=operation,
                command=command,
                reason=f"Operation '{operation}' requires approval",
            )
            self._pending_approvals.append(req)
            return req

        # Default: auto-approve
        return ApprovalRequest(
            operation=operation,
            command=command,
            reason="No approval required",
            status=ApprovalStatus.AUTO_APPROVED,
        )

    def _classify_operation(self, command: str) -> str:
        """Classify a command into an operation type."""
        if "git push" in command:
            if "--force" in command or "-f" in command:
                return "git_force_push"
            return "git_push"
        if "git merge" in command or "merge" in command:
            return "merge_pr"
        if "git branch -D" in command or "git push --delete" in command:
            return "delete_branch"
        if "docker push" in command:
            return "docker_push"
        if "fly deploy" in command or "flyctl deploy" in command:
            return "deploy_production"
        if "vercel" in command and "--prod" in command:
            return "deploy_production"
        if "wrangler deploy" in command:
            return "deploy_production"
        if "npm publish" in command:
            return "deploy_production"
        return "shell"

    def approve(self, request: ApprovalRequest, approved_by: str = "user"):
        """Approve a pending request."""
        request.status = ApprovalStatus.APPROVED
        request.approved_by = approved_by

    def deny(self, request: ApprovalRequest):
        """Deny a pending request."""
        request.status = ApprovalStatus.DENIED

    def check_spend(self, estimated_cost: float, task_id: Optional[str] = None) -> bool:
        """Check if an estimated cost is within budget."""
        if task_id is not None:
            self.spend_tracker.start_task(task_id)
        return self.spend_tracker.can_spend(estimated_cost)

    def record_spend(self, cost: float, task_id: Optional[str] = None):
        """Record actual spend."""
        self.spend_tracker.record_spend(cost, task_id)

    def get_pending_approvals(self) -> List[ApprovalRequest]:
        """Get all pending approval requests."""
        return [r for r in self._pending_approvals if r.status == ApprovalStatus.PENDING]

    def get_spend_status(self) -> Dict[str, Any]:
        """Get current spend status."""
        return self.spend_tracker.get_status()

    def execute_sandboxed(self, command: str, dry_run: bool = False) -> Dict[str, Any]:
        """Execute a command in sandbox mode (or dry run)."""
        approval = self.check_command(command)
        
        result = {
            "command": command,
            "approval_status": approval.status.value,
            "executed": False,
            "output": "",
            "error": "",
        }

        if approval.status == ApprovalStatus.DENIED:
            result["error"] = f"Command denied: {approval.reason}"
            return result

        if approval.status == ApprovalStatus.PENDING:
            result["error"] = f"Approval required: {approval.reason}"
            return result

        if dry_run:
            result["output"] = f"[DRY RUN] Would execute: {command}"
            result["executed"] = True
            return result

        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            result["output"] = proc.stdout
            result["error"] = proc.stderr
            result["executed"] = True
            result["returncode"] = proc.returncode
        except subprocess.TimeoutExpired:
            result["error"] = "Command timed out"
        except Exception as e:
            result["error"] = str(e)

        return result
