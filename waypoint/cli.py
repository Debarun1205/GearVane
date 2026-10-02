"""Command-line interface for Waypoint."""

import argparse
import json
import sys
import uuid
from pathlib import Path

import yaml

from . import __version__
from .classifier import TaskContext, Tier
from .cost import CostTracker
from .dashboard import DashboardGenerator
from .deployment import DeploymentManager
from .feedback import FeedbackLoop, FeedbackStore
from .health import HealthStatus, ModelHealthChecker
from .logger import RoutingLogger
from .model_manager import ModelManager
from .orchestrator import Orchestrator
from .router import TierRouter

DEFAULT_CONFIG_NAMES = ("config.yaml", "waypoint.yaml", "config.example.yaml")


def load_config(config_path: str) -> dict:
    """Load configuration from a YAML file.

    Falls back to well-known filenames when the requested path is absent, so
    a fresh clone works without copying the example config first.
    """
    path = Path(config_path)
    if not path.exists():
        # Try the default names before giving up.
        for name in DEFAULT_CONFIG_NAMES:
            candidate = Path(name)
            if candidate.exists():
                path = candidate
                print(f"Config {config_path} not found, using {name}", file=sys.stderr)
                break
        else:
            print(f"Config file not found: {config_path}", file=sys.stderr)
            print("Run 'cp config.example.yaml config.yaml' or pass --config.", file=sys.stderr)
            sys.exit(1)

    with open(path) as f:
        config = yaml.safe_load(f) or {}

    if not isinstance(config, dict):
        print(f"Config must be a YAML mapping, got {type(config).__name__}", file=sys.stderr)
        sys.exit(1)

    return config


def cmd_route(args):
    """Show the routing decision for a task without executing it."""
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
        print(f"Reasons: {', '.join(decision.reasons) or 'none'}")
        if decision.escalated:
            print("! ESCALATED due to previous failures")


def cmd_run(args):
    """Execute a task on the selected model."""
    config = load_config(args.config)
    orch = Orchestrator(config)

    task_id = args.task_id or str(uuid.uuid4())[:8]

    if args.stream:
        try:
            for token in orch.execute_stream(
                task_id,
                args.task,
                files_touched=args.files or [],
                system=args.system,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
            ):
                print(token, end="", flush=True)
            print()
        except KeyboardInterrupt:
            print("\nInterrupted", file=sys.stderr)
            sys.exit(130)
        return

    result = orch.execute(
        task_id,
        args.task,
        files_touched=args.files or [],
        system=args.system,
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        error_loops=args.error_loops or 0,
        test_failures=args.test_failures or 0,
    )

    if args.json:
        print(
            json.dumps(
                {
                    "task_id": result.task_id,
                    "success": result.success,
                    "tier": result.tier,
                    "provider": result.provider,
                    "model": result.model,
                    "attempts": result.attempts,
                    "escalated": result.escalated,
                    "cost_usd": result.cost_usd,
                    "tokens_in": result.tokens_in,
                    "tokens_out": result.tokens_out,
                    "duration_seconds": result.duration_seconds,
                    "error": result.error,
                    "history": result.history,
                },
                indent=2,
            )
        )
    else:
        status = "OK" if result.success else "FAILED"
        print(f"[{status}] {result.task_id}")
        if result.tier:
            print(f"Tier: {result.tier} / {result.provider}/{result.model}")
        print(f"Attempts: {result.attempts}" f"{' (escalated)' if result.escalated else ''}")
        print(f"Tokens: {result.tokens_in} in / {result.tokens_out} out")
        print(f"Cost: ${result.cost_usd:.4f}")
        print(f"Duration: {result.duration_seconds:.2f}s")
        if result.error:
            print(f"Error: {result.error}", file=sys.stderr)
        if result.success:
            print("\n--- response ---")
            print(result.content)

    if not result.success:
        sys.exit(1)


LOCAL_PROVIDERS = ("ollama", "lm_studio", "llama_cpp", "llamacpp", "vllm")


def cmd_health(args):
    """Check model availability by probing real endpoints."""
    config = load_config(args.config)
    checker = ModelHealthChecker(config)
    router = TierRouter(config)

    from .providers import ProviderFactory

    factory = ProviderFactory(timeout=5.0)

    for tier, tier_config in router.tiers.items():
        for provider in tier_config.providers:
            is_local = provider.name.lower() in LOCAL_PROVIDERS
            if args.offline and not is_local:
                continue

            # Build a real probe so the result reflects the actual endpoint.
            def make_probe(p=provider):
                def probe():
                    try:
                        return factory.create(p).health_check()
                    except Exception:
                        return False

                return probe

            for model in provider.models:
                checker.register_model(
                    model,
                    provider.name,
                    endpoint=provider.base_url,
                    probe=make_probe(),
                )

    import asyncio

    results = asyncio.run(checker.check_all())

    if args.json:
        print(
            json.dumps(
                [
                    {
                        "model": r.model,
                        "provider": r.provider,
                        "status": r.status.value,
                        "latency_ms": round(r.latency_ms, 2),
                        "message": r.message,
                    }
                    for r in results
                ],
                indent=2,
            )
        )
    else:
        for r in results:
            marker = {
                HealthStatus.HEALTHY: "OK",
                HealthStatus.DEGRADED: "DEGRADED",
                HealthStatus.UNHEALTHY: "UNHEALTHY",
                HealthStatus.UNKNOWN: "UNKNOWN",
            }[r.status]
            print(f"{marker:<10} {r.model:<32} {r.latency_ms:>8.1f}ms  {r.message}")

        counts = {status: 0 for status in HealthStatus}
        for r in results:
            counts[r.status] += 1
        print(
            f"\n{counts[HealthStatus.HEALTHY]} healthy, "
            f"{counts[HealthStatus.DEGRADED]} degraded, "
            f"{counts[HealthStatus.UNHEALTHY]} unhealthy, "
            f"{counts[HealthStatus.UNKNOWN]} unknown"
        )

    # Exit non-zero if any probed model is fully down.
    if any(r.status == HealthStatus.UNHEALTHY for r in results):
        sys.exit(1)


def cmd_models(args):
    """List local models available across providers."""
    config = load_config(args.config)
    manager = ModelManager(config)

    if args.json:
        models = manager.list_all_models()
        print(
            json.dumps(
                [
                    {
                        "name": m.name,
                        "provider": m.provider,
                        "size_mb": m.size_mb,
                        "status": m.status.value,
                    }
                    for m in models
                ],
                indent=2,
            )
        )
        return

    stats = manager.get_stats()
    print(f"Local models: {stats['total_models']} " f"({stats['total_size_gb']} GB)")
    print("\nProviders:")
    for provider, running in stats["providers_running"].items():
        print(f"  {'running ' if running else 'stopped '} {provider}")

    models = manager.list_all_models()
    if models:
        print("\nModels:")
        for m in models:
            size = f"{m.size_mb} MB" if m.size_mb else "-"
            print(f"  {m.name:<40} {m.provider:<12} {size}")
    else:
        print("\nNo local models found. Start Ollama or LM Studio, then pull a " "model.")


def cmd_cost(args):
    """Show cost statistics."""
    config = load_config(args.config)
    tracker = CostTracker(config)
    stats = tracker.get_stats()

    if args.json:
        print(json.dumps(stats, indent=2))
        return

    print(f"Calls:    {stats.get('total_calls', 0)}")
    print(
        f"Tokens:   {stats.get('total_tokens_in', 0)} in / "
        f"{stats.get('total_tokens_out', 0)} out"
    )
    print(f"Cost:     ${stats.get('total_cost_usd', 0.0)}")
    print(f"Session:  ${stats.get('session_spend_usd', 0.0)}")
    print(f"Day:      ${stats.get('day_spend_usd', 0.0)}")

    by_tier = stats.get("cost_by_tier", {})
    if by_tier:
        print("\nCost by tier:")
        for tier, cost in sorted(by_tier.items(), key=lambda kv: -kv[1]):
            print(f"  {tier:<12} ${cost}")


def cmd_dashboard(args):
    """Generate the HTML monitoring dashboard."""
    config = load_config(args.config)
    logger = RoutingLogger(config.get("logging", {}))
    tracker = CostTracker(config)
    checker = ModelHealthChecker(config)

    generator = DashboardGenerator(logger, tracker, checker)
    generator.save(args.output)

    print(f"Dashboard written to {args.output}")
    print(f"Open it with: start {args.output}")


def cmd_feedback(args):
    """Inspect recorded routing feedback."""
    config = load_config(args.config)
    path = config.get("logging", {}).get("feedback_file", "feedback.jsonl")
    loop = FeedbackLoop(FeedbackStore(path))

    stats = loop.store.get_stats()
    if args.json:
        print(json.dumps(stats, indent=2))
        return

    print(f"Entries:  {stats.get('total_entries', 0)}")
    print(f"Accuracy: {stats.get('accuracy', 0):.1%}")
    print(f"Rating:   {stats.get('average_rating', 0)}")

    by_tier = stats.get("by_tier", {})
    if by_tier:
        print("\nBy tier:")
        for tier, data in sorted(by_tier.items()):
            print(f"  {tier:<12} {data['correct']}/{data['total']} " f"({data['accuracy']:.0%})")

    suggestions = loop.get_adjustment_suggestions()
    if suggestions:
        print("\nSuggestions:")
        for s in suggestions:
            print(f"  - {s['message']}")


def cmd_train(args):
    """Train the learned classifier from recorded feedback."""
    config = load_config(args.config)
    learned_config = config.get("learned_classifier", {})
    feedback_path = learned_config.get(
        "feedback_file", config.get("logging", {}).get("feedback_file", "feedback.jsonl")
    )
    model_path = learned_config.get("model_file", "learned_model.json")

    from .learned_classifier import train_from_feedback

    classifier = train_from_feedback(
        model_path,
        feedback_path,
        learning_rate=args.learning_rate,
        epochs=args.epochs,
        l2=args.l2,
    )

    if not classifier.weights.is_trained():
        print(f"No labelled feedback found at {feedback_path}", file=sys.stderr)
        print("Run some tasks and record outcomes before training.", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(classifier.weights.to_dict(), indent=2))
        return

    print(f"Model saved to {model_path}")
    print(f"Samples:  {classifier.weights.trained_on}")
    print(f"Accuracy: {classifier.weights.accuracy:.1%}")
    print("\nStrongest features per tier:")
    for tier in Tier:
        features = classifier.top_features(tier, n=5)
        if features:
            rendered = ", ".join(f"{name} ({w})" for name, w in features)
            print(f"  {tier.value:<10} {rendered}")


def cmd_deploy(args):
    """Run deployment operations."""
    config = load_config(args.config)
    deployer = DeploymentManager(config)

    if args.dry_run:
        print("[DRY RUN MODE]")

    if args.tool == "github":
        if deployer.github is None:
            print("GitHub deploy is disabled in config", file=sys.stderr)
            sys.exit(1)
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
        if deployer.docker is None:
            print("Docker deploy is disabled in config", file=sys.stderr)
            sys.exit(1)
        if args.docker_action == "build":
            result = deployer.docker.build(tag=args.tag, dry_run=args.dry_run)
        elif args.docker_action == "push":
            result = deployer.docker.push(tag=args.tag, dry_run=args.dry_run)
        else:
            print(f"Unknown docker action: {args.docker_action}", file=sys.stderr)
            sys.exit(1)
    elif args.tool == "flyio":
        if deployer.flyio is None:
            print("Fly.io deploy is disabled in config", file=sys.stderr)
            sys.exit(1)
        result = deployer.flyio.deploy(app=args.app, dry_run=args.dry_run)
    elif args.tool == "vercel":
        if deployer.vercel is None:
            print("Vercel deploy is disabled in config", file=sys.stderr)
            sys.exit(1)
        result = deployer.vercel.deploy(prod=args.prod, dry_run=args.dry_run)
    elif args.tool == "cloudflare":
        if deployer.cloudflare is None:
            print("Cloudflare deploy is disabled in config", file=sys.stderr)
            sys.exit(1)
        result = deployer.cloudflare.deploy(dry_run=args.dry_run)
    else:
        print(f"Unknown tool: {args.tool}", file=sys.stderr)
        sys.exit(1)

    if result.approval_required:
        print(f"! Approval required: {result.error}")
        pending = deployer.get_pending_approvals()
        if pending:
            print("\nPending approvals:")
            for p in pending:
                print(f"  [{p['operation']}] {p['command']}")

    if result.output:
        print(result.output)
    if result.error:
        print(f"Error: {result.error}", file=sys.stderr)

    if not result.success:
        sys.exit(1)


def cmd_approve(args):
    """Approve a pending gated operation."""
    config = load_config(args.config)
    deployer = DeploymentManager(config)

    pending = deployer.get_pending_approvals()
    if not pending:
        print("No pending approvals")
        return

    if args.approve_command:
        if deployer.approve_operation(args.approve_command):
            print(f"Approved: {args.approve_command}")
        else:
            print(f"No pending approval matching: {args.approve_command}", file=sys.stderr)
            print("\nPending:", file=sys.stderr)
            for p in pending:
                print(f"  {p['command']}", file=sys.stderr)
            sys.exit(1)
    elif args.all:
        for req in deployer.safety.get_pending_approvals():
            deployer.safety.approve(req)
            print(f"Approved: {req.command}")
    else:
        print("Pending approvals:")
        for i, p in enumerate(pending, 1):
            print(f"  {i}. [{p['operation']}] {p['command']}")
        print('\nUse --command "<command>" or --all')
        sys.exit(1)


def cmd_stats(args):
    """Show routing statistics."""
    config = load_config(args.config)
    logger = RoutingLogger(config.get("logging", {}))
    stats = logger.get_stats()

    if args.json:
        print(json.dumps(stats, indent=2))
        return

    print(f"Routed:      {stats.get('total', 0)}")
    print(f"Successes:   {stats.get('successes', 0)}")
    print(f"Failures:    {stats.get('failures', 0)}")
    print(f"Escalations: {stats.get('escalations', 0)}")

    dist = stats.get("tier_distribution", {})
    if dist:
        print("\nTier distribution:")
        for tier, count in sorted(dist.items(), key=lambda kv: -kv[1]):
            print(f"  {tier:<12} {count}")


def cmd_safety(args):
    """Check safety status."""
    config = load_config(args.config)
    deployer = DeploymentManager(config)
    # The destination is safety_action, not "action": naming it "action"
    # shadowed the parser's own "command" dest, so the subcommand was
    # recorded as None and every safety invocation printed help.
    action = args.safety_action

    if action == "spend":
        status = deployer.safety.get_spend_status()
        if args.json:
            print(json.dumps(status, indent=2))
        else:
            print(
                f"Session: ${status['session_spend']} / "
                f"${status['session_remaining']} remaining"
            )
            print(f"Task:    ${status['task_spend']} / " f"${status['task_remaining']} remaining")
        return

    if action == "pending":
        pending = deployer.get_pending_approvals()
        if args.json:
            print(json.dumps(pending, indent=2))
        elif pending:
            print("Pending approvals:")
            for p in pending:
                print(f"  [{p['operation']}] {p['command']}")
        else:
            print("No pending approvals")
        return

    if action == "check":
        if not args.safety_command:
            print("safety check requires --command", file=sys.stderr)
            sys.exit(1)
        result = deployer.safety.execute_sandboxed(args.safety_command, dry_run=True)
        print(json.dumps(result, indent=2))
        if not result["executed"]:
            sys.exit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="waypoint",
        description="Waypoint - Open-source AI harness with intelligent task routing",
    )
    parser.add_argument("--config", default="config.yaml", help="Path to config file")
    parser.add_argument("--version", action="version", version=f"waypoint {__version__}")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # route
    p = subparsers.add_parser("route", help="Show routing decision (no execution)")
    p.add_argument("--task", required=True)
    p.add_argument("--task-id")
    p.add_argument("--files", nargs="*")
    p.add_argument("--error-loops", type=int, default=0)
    p.add_argument("--test-failures", type=int, default=0)
    p.add_argument("--json", action="store_true")

    # run
    p = subparsers.add_parser("run", help="Execute a task on the routed model")
    p.add_argument("--task", required=True)
    p.add_argument("--task-id")
    p.add_argument("--files", nargs="*")
    p.add_argument("--system")
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--max-tokens", type=int, default=2048)
    p.add_argument("--error-loops", type=int, default=0)
    p.add_argument("--test-failures", type=int, default=0)
    p.add_argument("--stream", action="store_true", help="Stream tokens")
    p.add_argument("--json", action="store_true")

    # health
    p = subparsers.add_parser("health", help="Check model availability")
    p.add_argument("--json", action="store_true")
    p.add_argument(
        "--offline", action="store_true", help="Only check local providers, skip hosted APIs"
    )

    # models
    p = subparsers.add_parser("models", help="List local models")
    p.add_argument("--json", action="store_true")

    # cost
    p = subparsers.add_parser("cost", help="Show cost statistics")
    p.add_argument("--json", action="store_true")

    # dashboard
    p = subparsers.add_parser("dashboard", help="Generate HTML dashboard")
    p.add_argument("--output", default="dashboard.html")

    # feedback
    p = subparsers.add_parser("feedback", help="Show routing feedback stats")
    p.add_argument("--json", action="store_true")

    # train
    p = subparsers.add_parser("train", help="Train the learned classifier")
    p.add_argument("--config", dest="unused_config", help=argparse.SUPPRESS)
    p.add_argument("--epochs", type=int, default=50)
    p.add_argument("--learning-rate", type=float, default=0.5)
    p.add_argument("--l2", type=float, default=0.001)
    p.add_argument("--json", action="store_true")

    # stats
    p = subparsers.add_parser("stats", help="Show routing statistics")
    p.add_argument("--json", action="store_true")

    # safety
    p = subparsers.add_parser("safety", help="Check safety status")
    p.add_argument(
        "safety_action",
        choices=["spend", "pending", "check"],
        help="spend: budget state, pending: gated operations, " "check: dry-run a command",
    )
    p.add_argument("--command", dest="safety_command", help="Command to check (for 'check')")
    p.add_argument("--json", action="store_true")

    # approve
    p = subparsers.add_parser("approve", help="Approve a pending operation")
    p.add_argument("--command", dest="approve_command", help="Exact command to approve")
    p.add_argument("--all", action="store_true", help="Approve all pending")

    # deploy
    p = subparsers.add_parser("deploy", help="Run deployment operations")
    p.add_argument("tool", choices=["github", "docker", "flyio", "vercel", "cloudflare"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--github-action", choices=["push", "pr", "status", "log"])
    p.add_argument("--docker-action", choices=["build", "push"])
    p.add_argument("--branch")
    p.add_argument("--title")
    p.add_argument("-n", type=int)
    p.add_argument("--tag")
    p.add_argument("--app")
    p.add_argument("--prod", action="store_true")

    return parser


def main():
    parser = build_parser()
    # --version and --help are argparse actions that exit during parse_args,
    # so they must not be short-circuited by the subcommand check below.
    if len(sys.argv) > 1 and sys.argv[1] in ("--version", "-V"):
        parser.parse_args()

    # Dispatch on sys.argv[1] directly. Subparser options can collide with the
    # parser's own "command" dest, so args.command is not reliable here.
    subcommand = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else None

    if subcommand is None:
        parser.print_help()
        sys.exit(1)

    args = parser.parse_args()

    if not hasattr(args, "command"):
        # A colliding subparser argument replaced the command dest.
        args.command = subcommand
    elif args.command != subcommand:
        args.command = subcommand

    handlers = {
        "route": cmd_route,
        "run": cmd_run,
        "health": cmd_health,
        "models": cmd_models,
        "cost": cmd_cost,
        "dashboard": cmd_dashboard,
        "feedback": cmd_feedback,
        "train": cmd_train,
        "stats": cmd_stats,
        "safety": cmd_safety,
        "approve": cmd_approve,
        "deploy": cmd_deploy,
    }

    handler = handlers.get(args.command)
    if handler is None:
        parser.print_help()
        sys.exit(1)

    handler(args)


if __name__ == "__main__":
    main()
