# Waypoint

An open-source AI harness that routes tasks to the right model tier — local, mid, or frontier — with built-in escalation, logging, and safe deployment tooling.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    OpenCode Core                      │
├─────────────────────────────────────────────────────┤
│  Waypoint Router Plugin                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Classifier  │→ │ Tier Router  │→ │ Escalation │  │
│  │ (heuristics │  │ (local/mid/  │  │ (auto-     │  │
│  │  + keywords)│  │  frontier)   │  │  promote)  │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
│  ┌─────────────┐  ┌──────────────┐                   │
│  │   Logger    │  │   Approval   │                   │
│  │ (decisions) │  │   Gates      │                   │
│  └─────────────┘  └──────────────┘                   │
├─────────────────────────────────────────────────────┤
│  Deployment Tools (GitHub, Docker, Fly.io, Vercel)   │
└─────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Install as a package
pip install -e .

# Run the router standalone
python -m waypoint route --task "Fix the login bug"

# Run with config
python -m waypoint route --config config.yaml --task "Refactor the auth module"

# Run the test suite
pytest tests/
```

## Configuration

Copy `config.example.yaml` to `config.yaml` and customize:

```bash
cp config.example.yaml config.yaml
```

### Tiers

| Tier | Models | Use Case |
|------|--------|----------|
| `local` | Ollama, llama.cpp, LM Studio | Simple edits, boilerplate, small refactors |
| `mid` | Haiku, Flash, small GPT | Medium complexity, multi-file changes |
| `frontier` | Claude, GPT-4, Gemini Ultra | Complex architecture, debugging, hard problems |

### Router Settings

- **Default tier**: `mid` (used when classification is uncertain)
- **Escalation**: Automatically promotes tasks that fail repeatedly
- **Manual override**: Pin a specific model for all tasks

### Safety

- **Approval gates** for all push/deploy operations
- **Scoped tokens** with minimal permissions
- **Spend limits** per session and per day
- **Sandboxed execution** for shell commands
- **Human-in-the-loop** for production deploys

## CLI Commands

```bash
# Route a task
waypoint route --task "Fix the typo in README" --files README.md

# Route with context
waypoint route --task "Refactor auth" --files src/auth/*.py --error-loops 2

# Check routing stats
waypoint stats

# Deploy (dry run)
waypoint deploy github --github-action push --dry-run

# Check safety status
waypoint safety spend
waypoint safety pending
```

## API Usage

```python
from waypoint.classifier import TaskContext
from waypoint.router import TierRouter

config = {
    "tiers": { ... },
    "router": { ... },
}

router = TierRouter(config)

context = TaskContext(
    description="Fix the login bug",
    files_touched=["src/auth/login.py"],
)

decision = router.route("task-1", context)
print(f"Routed to: {decision.tier.value} / {decision.model}")
```

## Project Structure

```
Waypoint/
├── waypoint/
│   ├── __init__.py
│   ├── __main__.py
│   ├── classifier.py      # Task classification
│   ├── router.py          # Tier routing + escalation
│   ├── logger.py          # Decision logging
│   ├── safety.py          # Approval gates + spend limits
│   ├── deployment.py      # Deploy tooling
│   └── cli.py             # CLI interface
├── tests/
│   ├── test_classifier.py
│   ├── test_router.py
│   └── test_safety.py
├── config.example.yaml
├── requirements.txt
└── setup.py
```

## Testing

```bash
# Run all tests
pytest tests/

# Run with coverage
pytest tests/ --cov=waypoint

# Run specific test file
pytest tests/test_router.py -v
```

## License

MIT
