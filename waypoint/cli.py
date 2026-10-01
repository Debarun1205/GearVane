"""Command-line interface for Waypoint."""

import argparse
import json
import sys
import uuid
from pathlib import Path

import yaml

from .classifier import TaskContext, Tier
from .router import TierRouter
from .logger import RoutingLogger
from .deployment import DeploymentManager


def load_config(config_path: str) -> dict:
    """Load configuration from YAML file."""
    path = Path(config_path)
    if not path.exists():
        print(f"Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    
    with open(path) as f:
        return yaml.safe_load(f)


def cmd_route(args):
    """Route a task to a model tier."""
    config = load_config(args.config)
    router = TierRouter(config)
    logger = RoutingLogger(config.get("logging", {}))
    
    task_id = args.task_id or str(uuid.uuid4())[:8]
    
    context = TaskContext(
        description=args.task,
        files_touched=args.files or [],
        error_loops=args.error_loops or 0,
        test_failures=args.test_failures or 0,
    )
    
    decision = router.route(task_id, context)
    logger.log_routing(task_id, decision, context)
    
    result = {
        "task_id": task_id,
        "tier": decision.tier.value,
        "provider": decision.provider.name,
        "model": decision.model,
        "confidence": decision.confidence,
        "reasons": decision.reasons,
        "escalated": decision.escalated,
        "attempt": decision.attempt,
    }
    
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Task: {task_id}")
        print(f"Tier: {decision.tier.value}")
        print(f"Provider: {decision.provider.name}")
        print(f"Model: {decision.model}")
        print(f"Confidence: {decision.confidence}")
        print(f"Reasons: {', '.join(decision.reasons)}")
        if decision.escalated:
            print("⚠️  ESCALATED due to previous failures")


def cmd_deploy(args):
    """Run deployment operations."""
    config = load_config(args.config)
    deployer = DeploymentManager(config)
    
    if args.dry_run:
        print("[DRY RUN MODE]")
    
    if args.tool == "github":
        if args.github_action == "push":
            result = deployer.github.push(branch=args.branch, dry_run=args.dry_run)
        elif args.github_action == "pr":
            result = deployer.github.create_pr(
                title=args.title or "Waypoint auto PR",
                branch=args.branch,
                dry_run=args.dry_run,
            )
        elif args.github_action == "status":
            result = deployer.github.get_status()
        elif args.github_action == "log":
            result = deployer.github.get_log(n=args.n or 10)
        else:
            print(f"Unknown github action: {args.github_action}", file=sys.stderr)
            sys.exit(1)
    elif args.tool == "docker":
        if args.docker_action == "build":
            result = deployer.docker.build(tag=args.tag, dry_run=args.dry_run)
        elif args.docker_action == "push":
            result = deployer.docker.push(tag=args.tag, dry_run=args.dry_run)
        else:
            print(f"Unknown docker action: {args.docker_action}", file=sys.stderr)
            sys.exit(1)
    elif args.tool == "flyio":
        result = deployer.flyio.deploy(app=args.app, dry_run=args.dry_run)
    elif args.tool == "vercel":
        result = deployer.vercel.deploy(prod=args.prod, dry_run=args.dry_run)
    elif args.tool == "cloudflare":
        result = deployer.cloudflare.deploy(dry_run=args.dry_run)
    else:
        print(f"Unknown tool: {args.tool}", file=sys.stderr)
        sys.exit(1)
    
    if result.approval_required:
        print(f"⚠️  Approval required: {result.error}")
        print("Run with --approve to approve pending operations")
    
    if result.output:
        print(result.output)
    if result.error:
        print(f"Error: {result.error}", file=sys.stderr)
    
    if not result.success:
        sys.exit(1)


def cmd_stats(args):
    """Show routing statistics."""
    config = load_config(args.config)
    logger = RoutingLogger(config.get("logging", {}))
    stats = logger.get_stats()
    print(json.dumps(stats, indent=2))


def cmd_safety(args):
    """Check safety status."""
    config = load_config(args.config)
    deployer = DeploymentManager(config)
    
    if args.safety_action == "spend":
        status = deployer.safety.get_spend_status()
        print(json.dumps(status, indent=2))
    elif args.safety_action == "pending":
        pending = deployer.get_pending_approvals()
        print(json.dumps(pending, indent=2))
    elif args.safety_action == "check":
        result = deployer.safety.execute_sandboxed(args.command, dry_run=True)
        print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(
        prog="waypoint",
        description="Waypoint - Open-source AI harness with intelligent task routing",
    )
    parser.add_argument("--config", default="config.yaml", help="Path to config file")
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # Route command
    route_parser = subparsers.add_parser("route", help="Route a task to a model tier")
    route_parser.add_argument("--task", required=True, help="Task description")
    route_parser.add_argument("--task-id", help="Task ID (auto-generated if not provided)")
    route_parser.add_argument("--files", nargs="*", help="Files touched by the task")
    route_parser.add_argument("--error-loops", type=int, default=0, help="Number of error loops")
    route_parser.add_argument("--test-failures", type=int, default=0, help="Number of test failures")
    route_parser.add_argument("--json", action="store_true", help="Output as JSON")
    
    # Deploy command
    deploy_parser = subparsers.add_parser("deploy", help="Run deployment operations")
    deploy_parser.add_argument("tool", choices=["github", "docker", "flyio", "vercel", "cloudflare"])
    deploy_parser.add_argument("--dry-run", action="store_true", help="Dry run mode")
    
    # GitHub sub-actions
    deploy_parser.add_argument("--github-action", choices=["push", "pr", "status", "log"])
    deploy_parser.add_argument("--branch", help="Git branch")
    deploy_parser.add_argument("--title", help="PR title")
    deploy_parser.add_argument("-n", type=int, help="Number of log entries")
    
    # Docker sub-actions
    deploy_parser.add_argument("--docker-action", choices=["build", "push"])
    deploy_parser.add_argument("--tag", help="Docker image tag")
    
    # Fly.io
    deploy_parser.add_argument("--app", help="Fly.io app name")
    
    # Vercel
    deploy_parser.add_argument("--prod", action="store_true", help="Deploy to production")
    
    # Stats command
    stats_parser = subparsers.add_parser("stats", help="Show routing statistics")
    
    # Safety command
    safety_parser = subparsers.add_parser("safety", help="Check safety status")
    safety_parser.add_argument("safety_action", choices=["spend", "pending", "check"])
    safety_parser.add_argument("--command", help="Command to check")
    
    args = parser.parse_args()
    
    if args.command == "route":
        cmd_route(args)
    elif args.command == "deploy":
        cmd_deploy(args)
    elif args.command == "stats":
        cmd_stats(args)
    elif args.command == "safety":
        cmd_safety(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
