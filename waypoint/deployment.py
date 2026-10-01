"""Deployment tools: GitHub, Docker, Fly.io, Vercel, Cloudflare."""

import subprocess
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .safety import ApprovalStatus, SafetyManager


@dataclass
class DeployResult:
    success: bool
    tool: str
    # Optional because most call sites only set success/output/error.
    message: str = ""
    output: str = ""
    error: str = ""
    approval_required: bool = False


class GitHubDeployer:
    """GitHub operations with approval gates."""

    def __init__(self, safety: SafetyManager, config: Dict[str, Any]):
        self.safety = safety
        self.config = config
        self.require_push_approval = config.get("require_approval_for_push", True)
        self.require_pr_approval = config.get("require_approval_for_pr", False)
        self.default_branch = config.get("default_branch", "main")

    def _run_git(self, command: str, dry_run: bool = False) -> DeployResult:
        """Run a git command with safety checks."""
        approval = self.safety.check_command(command)

        if approval.status == ApprovalStatus.DENIED:
            return DeployResult(
                success=False,
                tool="github",
                error=f"Command denied: {approval.reason}",
            )

        if approval.status == ApprovalStatus.PENDING:
            return DeployResult(
                success=False,
                tool="github",
                error=f"Approval required: {approval.reason}",
                approval_required=True,
            )

        if dry_run:
            return DeployResult(
                success=True,
                tool="github",
                output=f"[DRY RUN] Would execute: git {command}",
            )

        try:
            proc = subprocess.run(
                f"git {command}",
                shell=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            return DeployResult(
                success=proc.returncode == 0,
                tool="github",
                output=proc.stdout,
                error=proc.stderr,
            )
        except Exception as e:
            return DeployResult(
                success=False,
                tool="github",
                error=str(e),
            )

    def push(self, branch: Optional[str] = None, dry_run: bool = False) -> DeployResult:
        """Push to remote with approval gate."""
        branch = branch or self.default_branch
        return self._run_git(f"push origin {branch}", dry_run=dry_run)

    def create_pr(
        self, title: str, body: str = "", branch: Optional[str] = None, dry_run: bool = False
    ) -> DeployResult:
        """Create a pull request."""
        branch = branch or self.default_branch

        if dry_run:
            return DeployResult(
                success=True,
                tool="github",
                output=f"[DRY RUN] Would create PR: {title}",
            )

        # Use gh CLI if available
        try:
            cmd = f'gh pr create --title "{title}" --body "{body}" --head {branch}'
            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            return DeployResult(
                success=proc.returncode == 0,
                tool="github",
                output=proc.stdout,
                error=proc.stderr,
            )
        except Exception as e:
            return DeployResult(
                success=False,
                tool="github",
                error=str(e),
            )

    def get_status(self) -> DeployResult:
        """Get repo status."""
        return self._run_git("status")

    def get_log(self, n: int = 10) -> DeployResult:
        """Get recent commits."""
        return self._run_git(f"log --oneline -n {n}")


class DockerDeployer:
    """Docker operations with approval gates."""

    def __init__(self, safety: SafetyManager, config: Dict[str, Any]):
        self.safety = safety
        self.config = config
        self.require_build_approval = config.get("require_approval_for_build", False)
        self.require_push_approval = config.get("require_approval_for_push", True)

    def build(
        self, tag: str, dockerfile: str = "Dockerfile", dry_run: bool = False
    ) -> DeployResult:
        """Build a Docker image."""
        command = f"docker build -t {tag} -f {dockerfile} ."
        approval = self.safety.check_command(command)

        if approval.status == ApprovalStatus.PENDING:
            return DeployResult(
                success=False,
                tool="docker",
                error=f"Approval required: {approval.reason}",
                approval_required=True,
            )

        if dry_run:
            return DeployResult(
                success=True,
                tool="docker",
                output=f"[DRY RUN] Would execute: {command}",
            )

        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=600,
            )
            return DeployResult(
                success=proc.returncode == 0,
                tool="docker",
                output=proc.stdout,
                error=proc.stderr,
            )
        except Exception as e:
            return DeployResult(
                success=False,
                tool="docker",
                error=str(e),
            )

    def push(self, tag: str, dry_run: bool = False) -> DeployResult:
        """Push a Docker image."""
        command = f"docker push {tag}"
        approval = self.safety.check_command(command)

        if approval.status == ApprovalStatus.PENDING:
            return DeployResult(
                success=False,
                tool="docker",
                error=f"Approval required: {approval.reason}",
                approval_required=True,
            )

        if dry_run:
            return DeployResult(
                success=True,
                tool="docker",
                output=f"[DRY RUN] Would execute: {command}",
            )

        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            return DeployResult(
                success=proc.returncode == 0,
                tool="docker",
                output=proc.stdout,
                error=proc.stderr,
            )
        except Exception as e:
            return DeployResult(
                success=False,
                tool="docker",
                error=str(e),
            )


class FlyioDeployer:
    """Fly.io operations with approval gates."""

    def __init__(self, safety: SafetyManager, config: Dict[str, Any]):
        self.safety = safety
        self.config = config
        self.require_deploy_approval = config.get("require_approval_for_deploy", True)

    def deploy(self, app: Optional[str] = None, dry_run: bool = False) -> DeployResult:
        """Deploy to Fly.io."""
        cmd = "fly deploy"
        if app:
            cmd += f" --app {app}"

        approval = self.safety.check_command(cmd)

        if approval.status == ApprovalStatus.PENDING:
            return DeployResult(
                success=False,
                tool="flyio",
                error=f"Approval required: {approval.reason}",
                approval_required=True,
            )

        if dry_run:
            return DeployResult(
                success=True,
                tool="flyio",
                output=f"[DRY RUN] Would execute: {cmd}",
            )

        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            return DeployResult(
                success=proc.returncode == 0,
                tool="flyio",
                output=proc.stdout,
                error=proc.stderr,
            )
        except Exception as e:
            return DeployResult(
                success=False,
                tool="flyio",
                error=str(e),
            )


class VercelDeployer:
    """Vercel operations with approval gates."""

    def __init__(self, safety: SafetyManager, config: Dict[str, Any]):
        self.safety = safety
        self.config = config
        self.require_deploy_approval = config.get("require_approval_for_deploy", True)

    def deploy(self, prod: bool = False, dry_run: bool = False) -> DeployResult:
        """Deploy to Vercel."""
        cmd = "vercel deploy"
        if prod:
            cmd += " --prod"

        approval = self.safety.check_command(cmd)

        if approval.status == ApprovalStatus.PENDING:
            return DeployResult(
                success=False,
                tool="vercel",
                error=f"Approval required: {approval.reason}",
                approval_required=True,
            )

        if dry_run:
            return DeployResult(
                success=True,
                tool="vercel",
                output=f"[DRY RUN] Would execute: {cmd}",
            )

        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            return DeployResult(
                success=proc.returncode == 0,
                tool="vercel",
                output=proc.stdout,
                error=proc.stderr,
            )
        except Exception as e:
            return DeployResult(
                success=False,
                tool="vercel",
                error=str(e),
            )


class CloudflareDeployer:
    """Cloudflare Workers operations with approval gates."""

    def __init__(self, safety: SafetyManager, config: Dict[str, Any]):
        self.safety = safety
        self.config = config
        self.require_deploy_approval = config.get("require_approval_for_deploy", True)

    def deploy(self, dry_run: bool = False) -> DeployResult:
        """Deploy to Cloudflare Workers."""
        cmd = "wrangler deploy"

        approval = self.safety.check_command(cmd)

        if approval.status == ApprovalStatus.PENDING:
            return DeployResult(
                success=False,
                tool="cloudflare",
                error=f"Approval required: {approval.reason}",
                approval_required=True,
            )

        if dry_run:
            return DeployResult(
                success=True,
                tool="cloudflare",
                output=f"[DRY RUN] Would execute: {cmd}",
            )

        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            return DeployResult(
                success=proc.returncode == 0,
                tool="cloudflare",
                output=proc.stdout,
                error=proc.stderr,
            )
        except Exception as e:
            return DeployResult(
                success=False,
                tool="cloudflare",
                error=str(e),
            )


class DeploymentManager:
    """Manages all deployment tools."""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.safety = SafetyManager(config)

        deploy_config = config.get("deployment", {})

        self.github = (
            GitHubDeployer(self.safety, deploy_config.get("github", {}))
            if deploy_config.get("github", {}).get("enabled", False)
            else None
        )

        self.docker = (
            DockerDeployer(self.safety, deploy_config.get("docker", {}))
            if deploy_config.get("docker", {}).get("enabled", False)
            else None
        )

        self.flyio = (
            FlyioDeployer(self.safety, deploy_config.get("flyio", {}))
            if deploy_config.get("flyio", {}).get("enabled", False)
            else None
        )

        self.vercel = (
            VercelDeployer(self.safety, deploy_config.get("vercel", {}))
            if deploy_config.get("vercel", {}).get("enabled", False)
            else None
        )

        self.cloudflare = (
            CloudflareDeployer(self.safety, deploy_config.get("cloudflare", {}))
            if deploy_config.get("cloudflare", {}).get("enabled", False)
            else None
        )

    def get_pending_approvals(self) -> List[Dict[str, Any]]:
        """Get all pending approval requests."""
        return [
            {
                "operation": r.operation,
                "command": r.command,
                "reason": r.reason,
            }
            for r in self.safety.get_pending_approvals()
        ]

    def approve_operation(self, command: str) -> bool:
        """Approve a pending operation."""
        for req in self.safety.get_pending_approvals():
            if req.command == command:
                self.safety.approve(req)
                return True
        return False
