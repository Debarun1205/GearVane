# Waypoint

An open-source AI harness that routes each task to the right model tier —
local, mid, or frontier — with escalation, cost control, and gated
deployment tooling.

Built on OpenCode's model-agnostic approach: you bring your own API keys,
and local models stay free.

## Why

Hosted models are billed per token, so the expensive ones should only run
on work that needs them. Waypoint classifies a task, picks the cheapest
tier likely to succeed, and escalates only when a cheaper model actually
fails.

## Architecture

```
                    ┌──────────────────────────┐
   task ──────────► │      Orchestrator        │
                    │  budget gate → execute   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │       TierRouter         │
                    │  heuristics + learned    │
                    │  manual override         │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌──────────┐      ┌──────────┐       ┌────────────┐
        │  local   │      │   mid    │       │  frontier  │
        │ Ollama   │      │ Haiku    │       │ Claude/GPT │
        │ LM Studio│      │ Flash    │       │            │
        │ llama.cpp│      │ mini     │       │            │
        └────┬─────┘      └────┬─────┘       └─────┬──────┘
             │                 │                  │
             └─────────────────┴──────────────────┘
                               │
                  ┌────────────▼─────────────┐
                  │  providers (urllib)      │
                  │  Ollama / OpenAI-compat  │
                  │  Anthropic               │
                  └────────────┬─────────────┘
                               │
       cost tracking · health checks · retry · circuit breaker
       approval gates · feedback loop · deployment tooling
```

## Install

```bash
git clone https://github.com/Debarun1205/Waypoint
cd Waypoint

python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt
pip install -e .
```

Requires Python 3.9+. The core is stdlib-only: providers use `urllib` and
the learned classifier is implemented directly, so there is no HTTP client
or ML framework to install.

## Configure

```bash
cp config.example.yaml config.yaml
```

`config.example.yaml` is a documented reference covering every key the
code reads. Two things to set:

**Local models** — install [Ollama](https://ollama.com), then:

```bash
ollama pull qwen2.5-coder
```

**Hosted models** — export a key if you use them:

```bash
export ANTHROPIC_API_KEY=<your-anthropic-key>
export OPENROUTER_API_KEY=<your-openrouter-key>
```

Keys are read from the environment only, never stored in config.

To run everything locally with no keys at all, delete the `mid` and
`frontier` tiers and set `router.default_tier: local`.

## Use

```bash
# See where a task would run, without running it
waypoint route --task "Fix a typo in README" --files README.md

waypoint run --task "Fix a typo in README" --files README.md

# Stream tokens as they arrive
waypoint run --task "Explain this module" --files src/app.py --stream

# Check every configured model against its real endpoint
waypoint health
waypoint health --offline      # local providers only

# Local models and provider status
waypoint models

# Cost, spend limits, routing stats
waypoint cost
waypoint safety spend
waypoint stats

# Monitoring dashboard
waypoint dashboard --output dashboard.html
```

Add `--json` to any command for machine-readable output.

## Tiers

| Tier | Models | Use for |
|------|--------|---------|
| `local` | Ollama, LM Studio, llama.cpp | Simple edits, boilerplate, small refactors |
| `mid` | Haiku, Flash, GPT-4o-mini | Medium complexity, multi-file changes |
| `frontier` | Claude Sonnet/Opus, GPT-4o, o3 | Architecture, debugging, performance work |

Classification blends cheap signals — task keywords, files touched, error
loops, test failures — into a tier decision with a confidence score.

## Escalation

When a task fails, the failure is fed back into the next classification. After
`max_attempts_per_tier` consecutive failures the task moves up a tier. A
permanent failure (bad API key, invalid request) is never retried.

```
attempt 1  local    fails  ─┐
attempt 2  local    fails  ─┘ 2 failures ≥ threshold
attempt 3  mid      fails
attempt 4  frontier succeeds
```

`max_escalations` bounds how far a task can climb, so a genuinely
impossible task cannot burn every tier in sequence.

## Cost control

Budget is checked *before* tokens are spent, using the tier's
`cost_per_token`. A task that cannot fit the budget never reaches a
provider.

```yaml
safety:
  spend_limits:
    per_task: 5.0
    per_session: 10.0
    per_day: 50.0
```

```bash
waypoint safety spend
# Session: $2.31 / $7.69 remaining
```

## Learned classifier

The heuristics are transparent but never improve. Record outcomes, then
train a small logistic-regression model on them:

```bash
waypoint run --task "..."          # runs and logs the decision
waypoint train                     # trains from feedback.jsonl
```

Then enable it in config:

```yaml
learned_classifier:
  enabled: true
  model_file: learned_model.json
  min_samples: 10
  blend: 0.5
```

It only engages after `min_samples` outcomes exist. On disagreement the
heuristic wins at reduced confidence, so a poorly trained model degrades
to current behaviour instead of silently rerouting work.

`waypoint train` prints the strongest features per tier, so you can see
what it learned.

## Safety

Commands run through an allowlist. Anything not permitted requires approval,
and some commands never run:

```yaml
safety:
  require_approval: [git_push, deploy_production, merge_pr]
  sandbox_allowed: ["git status", "git log", "pytest", "ls"]
  blocked_commands: ["rm -rf", "sudo", "chmod 777"]
```

```bash
waypoint deploy github --github-action push   # refuses without approval
waypoint safety pending                       # list gated operations
waypoint approve --command "git push origin main"
```

## OpenCode integration

Waypoint integrates as a plugin rather than a fork, so it does not track
upstream changes:

```python
from waypoint.opencode_plugin import WaypointPlugin

plugin = WaypointPlugin()

# Route without executing
plugin.classify_task("Fix a typo", files=["README.md"])
# {'tier': 'local', 'provider': 'ollama', 'model': 'qwen2.5-coder', ...}

# Execute
plugin.execute_task("Summarize this module", files=["src/app.py"])
# {'success': True, 'content': '...', 'cost_usd': 0.0, ...}
```

Module-level functions (`classify_task`, `execute_task`, `select_model`,
`stats`) are available for hosts that call functions rather than managing
an instance.

## Deployment

GitHub, Docker, Fly.io, Vercel, and Cloudflare, each behind an approval
gate. Enabled per tool in config.

```bash
waypoint deploy github --github-action status
waypoint deploy github --github-action push --dry-run
waypoint deploy docker --docker-action build --tag myapp:latest
```

## CLI reference

| Command | Purpose |
|---------|---------|
| `route` | Show the routing decision without executing |
| `run` | Execute a task; `--stream` for tokens |
| `health` | Probe every configured model |
| `models` | List local models and provider status |
| `cost` | Cost breakdown by tier and model |
| `stats` | Routing statistics |
| `feedback` | Recorded outcomes and accuracy |
| `train` | Train the learned classifier |
| `dashboard` | Generate the HTML dashboard |
| `safety spend\|pending\|check` | Budget, gated operations, command check |
| `approve` | Approve a pending operation |
| `deploy` | Run deployment operations |

## Development

```bash
pip install -r requirements-dev.txt

pytest tests/                       # 262 tests
pytest tests/ --cov=waypoint        # coverage
flake8 waypoint/ tests/
black --check waypoint/ tests/
isort --check-only waypoint/ tests/
mypy waypoint/
```

CI runs tests on Python 3.9–3.12, all four linters, a CLI smoke job that
executes the shipped commands, and a package build.

## Project layout

```
Waypoint/
├── waypoint/
│   ├── classifier.py          heuristic tier classification
│   ├── learned_classifier.py  logistic regression over task features
│   ├── router.py              tier selection, escalation, overrides
│   ├── providers.py           Ollama, OpenAI-compat, Anthropic clients
│   ├── orchestrator.py        end-to-end execution with budget gates
│   ├── retry.py               backoff, jitter, circuit breaker
│   ├── health.py              model availability probing
│   ├── cost.py                cost tracking and budget alerts
│   ├── logger.py              routing decision logs
│   ├── feedback.py            outcome recording
│   ├── safety.py              approval gates, spend limits, sandboxing
│   ├── deployment.py          GitHub, Docker, Fly.io, Vercel, Cloudflare
│   ├── dashboard.py           HTML monitoring dashboard
│   ├── model_manager.py       local model discovery
│   ├── plugin.py              plugin lifecycle and hooks
│   ├── opencode_plugin.py     OpenCode host integration
│   └── cli.py                 command line interface
├── tests/                     262 tests
├── config.example.yaml        documented configuration reference
└── Dockerfile                 container image
```

## Status

Alpha. The router, providers, escalation, budget gates, and CLI are
tested end to end. The learned classifier trains and predicts but has not
been evaluated against real production traffic yet, which is the obvious
next step.

## Security

API keys are read from the environment only and are never written to a
config file, log, or dashboard. Deployments sit behind approval gates that
refuse to run even under `--dry-run`.

See [SECURITY.md](SECURITY.md) for credential handling, how to report a
vulnerability, and the behaviours the approval gates depend on.

## License

MIT