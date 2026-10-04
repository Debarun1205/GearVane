# GearVane for VS Code

Route each request to the cheapest model tier that can actually do the job.

GearVane does not replace your editor or your model of choice. It reads the
selection, decides whether a local model is enough, and only reaches for an
expensive model when the work warrants it.

## Why

Running a frontier model for a typo fix wastes money. Running a 3B local
model to debug a race condition wastes your afternoon. GearVane classifies
the task, picks a tier, and escalates only when a cheaper model fails.

## Commands

| Command | What it does |
|---------|--------------|
| `GearVane: Route Selection` | Shows which tier would handle the selection, without spending anything |
| `GearVane: Explain Routing Decision` | Opens a markdown breakdown of the tier, confidence, and reasons |
| `GearVane: Ask` | Sends a prompt through the routed model |
| `GearVane: Check Model Health` | Probes every configured model |
| `GearVane: Show Spend` | Session and task spend against your limits |
| `GearVane: Show Routing Log` | Recent decisions with outcomes and timings |
| `GearVane: Pin Model` | Pins a model for the workspace |
| `GearVane: Clear Pinned Model` | Returns to automatic routing |

All are also available from the command palette with `Ctrl+Shift+P` /
`Cmd+Shift+P`.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `gearvane.configPath` | `""` | Path to a config file; empty searches upward |
| `gearvane.tier` | `auto` | Force `local`, `mid`, or `frontier` |
| `gearvane.model` | `""` | Pin a model such as `anthropic/claude-sonnet-4-20250514` |
| `gearvane.includeSelectionInPrompt` | `true` | Include the selected text when routing |
| `gearvane.maxTokens` | `2048` | Token ceiling per request |
| `gearvane.showRoutingNotifications` | `true` | Notify with the chosen tier |

## Setup

Add a `gearvane.yaml` at the root of your workspace:

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
`gearvane.yaml` with at least one tier, or check `gearvane.configPath`.

**A model shows as degraded** — the endpoint did not answer. Run
`GearVane: Check Model Health` and confirm Ollama is running.

**Everything routes to local** — that is usually correct. Use
`gearvane.tier` to force a higher tier while debugging a routing problem.

## License

MIT