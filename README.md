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

# Run the router standalone
python -m waypoint.router --task "Fix the login bug"

# Run with config
python -m waypoint.router --config config.yaml --task "Refactor the auth module"

# Run the test suite
pytest tests/
```

## Configuration

See `config.example.yaml` for a full configuration reference.

## Tiers

| Tier | Models | Use Case |
|------|--------|----------|
| `local` | Ollama, llama.cpp, LM Studio | Simple edits, boilerplate, small refactors |
| `mid` | Haiku, Flash, small GPT | Medium complexity, multi-file changes |
| `frontier` | Claude, GPT-4, Gemini Ultra | Complex architecture, debugging, hard problems |

## Safety

- **Approval gates** for all push/deploy operations
- **Scoped tokens** with minimal permissions
- **Spend limits** per session and per day
- **Sandboxed execution** for shell commands
- **Human-in-the-loop** for production deploys

## License

MIT
