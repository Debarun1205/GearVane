"""Safety module: approval gates, spend limits, and sandboxing."""

import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Set


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
    """Record what a session cost. Enforces nothing.

    The per-session, per-day and per-task ceilings this used to carry are gone.
    They blocked runs against budgets nobody had agreed to, and the default of
    $10/$50/$5 was enforced as though the user had set it. A ceiling on a local
    model is a ceiling on $0.

    What remains is the arithmetic a user actually wants after the fact: what
    did this session cost, and how much of it was free. Run safety is bounded by
    iterations and wall-clock time instead, which is a safeguard against a
    runaway loop rather than a budget.
    """

    session_spend: float = 0.0
    day_spend: float = 0.0
    task_spend: float = 0.0
    _session_start: float = field(default_factory=time.time)
    _day_start: float = field(default_factory=time.time)
    _current_task_id: Optional[str] = None

    def start_task(self, task_id: str):
        """Begin tracking a new task, resetting its running total.

        Per-task spend must reset when the task changes. Previously this was
        only resettable via an explicit reset_task() call that no caller made,
        so once task_spend hit per_task_limit every later task was blocked for
        the life of the process.
        """
        if self._current_task_id != task_id:
            self.task_spend = 0.0
            self._current_task_id = task_id

    def can_spend(self, amount: float) -> bool:
        """Always true. No spend limit is enforced, for any model.

        Kept so callers keep their shape and so this stays a single place to
        reintroduce an opt-in cap. A false here means "blocked", and nothing
        sets one.
        """
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
        """Get current spend status.

        No `*_remaining` keys: with no limit there is no remaining budget, and
        reporting one against a number the user never set is the confusion this
        whole change exists to remove.
        """
        return {
            "session_spend": round(self.session_spend, 4),
            "day_spend": round(self.day_spend, 4),
            "task_spend": round(self.task_spend, 4),
            "limits": "none",
            "enforced": False,
        }


class SafetyManager:
    """Manages safety: approvals and sandboxing.

    Spend tracking is recording only. There are no spend limits, so there is
    nothing here to configure and no default budget to impose.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        safety_config = self.config.get("safety", {})

        # Approval settings
        self.require_approval: Set[str] = set(safety_config.get("require_approval", []))

        # Usage recording. No limits are read from config.
        self.spend_tracker = SpendTracker()

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

        result: Dict[str, Any] = {
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
