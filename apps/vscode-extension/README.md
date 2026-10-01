# Waypoint for VS Code

Route each request to the cheapest model tier that can actually do the job.

Waypoint does not replace your editor or your model of choice. It reads the
selection, decides whether a local model is enough, and only reaches for an
expensive model when the work warrants it.

## Why

Running a frontier model for a typo fix wastes money. Running a 3B local
model to debug a race condition wastes your afternoon. Waypoint classifies
the task, picks a tier, and escalates only when a cheaper model fails.

## Commands

| Command | What it does |
|---------|--------------|
| `Waypoint: Route Selection` | Shows which tier would handle the selection, without spending anything |
| `Waypoint: Explain Routing Decision` | Opens a markdown breakdown of the tier, confidence, and reasons |
| `Waypoint: Ask` | Sends a prompt through the routed model |
| `Waypoint: Check Model Health` | Probes every configured model |
| `Waypoint: Show Spend` | Session and task spend against your limits |
| `Waypoint: Show Routing Log` | Recent decisions with outcomes and timings |
| `Waypoint: Pin Model` | Pins a model for the workspace |
| `Waypoint: Clear Pinned Model` | Returns to automatic routing |

All are also available from the command palette with `Ctrl+Shift+P` /
`Cmd+Shift+P`.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `waypoint.configPath` | `""` | Path to a config file; empty searches upward |
| `waypoint.tier` | `auto` | Force `local`, `mid`, or `frontier` |
| `waypoint.model` | `""` | Pin a model such as `anthropic/claude-sonnet-4-20250514` |
| `waypoint.includeSelectionInPrompt` | `true` | Include the selected text when routing |
| `waypoint.maxTokens` | `2048` | Token ceiling per request |
| `waypoint.showRoutingNotifications` | `true` | Notify with the chosen tier |

## Setup

Add a `waypoint.yaml` at the root of your workspace:

```yaml
router:
  default_tier: local

tiers:
  local:
    providers:
      - name: ollama
        base_url: http://localhost:11434
        models: [qwen2.5-coder]

safety:
  spend_limits:
    per_task: 1.0
    per_session: 5.0
```

For hosted models, export a key in your shell. The extension reads the
environment and never stores credentials:

```bash
export ANTHROPIC_API_KEY=...
```

## Running the local model

```bash
ollama pull qwen2.5-coder
```

## Privacy

Requests go only to the providers you configure. With a local model
configured and no hosted key in the environment, nothing leaves your
machine.

## Troubleshooting

**"No usable model tiers configured"** — no provider was found. Add a
`waypoint.yaml` with at least one tier, or check `waypoint.configPath`.

**A model shows as degraded** — the endpoint did not answer. Run
`Waypoint: Check Model Health` and confirm Ollama is running.

**Everything routes to local** — that is usually correct. Use
`waypoint.tier` to force a higher tier while debugging a routing problem.

## License

MIT