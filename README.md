# GearVane

Route each prompt to the cheapest model tier that can actually do the job.

Simple edits run on a local model for free. Hard problems reach for a
frontier model, and only then. When a cheap model fails, the task escalates
instead of guessing.

```
              ┌──────────────────────────────────────┐
   prompt ──► │  classify → run → escalate on fail  │
              └──────────────────┬───────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
   ┌─────────┐             ┌─────────┐             ┌───────────┐
   │  local  │             │   mid   │             │ frontier  │
   │ Ollama  │             │ Haiku   │             │ Claude    │
   │ LM St.  │             │ Flash   │             │ GPT-4o    │
   │ free    │             │ cheap   │             │ billed    │
   └─────────┘             └─────────┘             └───────────┘
```

## What is in this repository

| Component | Path | Platform |
|-----------|------|----------|
| TypeScript engine | `packages/core` | Node, browser, Electron, Android |
| Harness | `packages/harness` | Node |
| CLI | `packages/cli` | Node |
| Shared app logic | `apps/app-core` | Node, browser |
| Desktop app | `apps/desktop` | Windows, Linux, macOS, Android |
| VS Code extension | `apps/vscode-extension` | VS Code and forks |
| Website | `site` | any static host |
| Python engine | `gearvane/` | reference implementation |

Two engines exist because Android cannot bundle a Python runtime. The
TypeScript port is what the CLI, app, and extension use; the Python package
remains the reference and is tested for identical routing behaviour.

The harness is under construction. It has workspace path containment, a tool
layer with file tools and a gated shell, tool-calling support in the provider
clients, an agent loop, context budgeting, and session persistence.

Session files have credential-shaped text stripped before writing. That is a
useful default, not a guarantee: a key in an unusual format, or one the agent
never echoed, will not be caught.

Be clear about what the shell tool is: it gates commands through
`SafetyManager`, refuses blocked ones, pins the working directory to the
workspace, strips provider keys from the child environment, and bounds runtime
and output. **It is not a sandbox.** An approved command can still read and
write anywhere you can; real containment needs an OS-level boundary that is not
implemented here.

[docs/harness-architecture.md](docs/harness-architecture.md) is the source of
truth, and a test checks its status table against the repository so it cannot
drift.

## Quick start

Pick a local model and nothing leaves your machine:

```bash
# Install a local model once
ollama pull qwen2.5-coder

# Ask something trivial, and watch it stay on the free tier
gearvane route --task "Fix the typo in README.md" --files README.md

# Ask something hard, and watch it escalate
gearvane run --task "Investigate a race condition in the cache writer under load"
```

## Install

### The app

Download a build for your platform from the
[v0.3.0 release](https://github.com/Debarun1205/GearVane/releases/tag/v0.3.0):

| Platform | File | Size |
|----------|------|------|
| Windows x64 (installer) | `Waypoint.Setup.0.3.0.exe` | 93 MB |
| Windows x64 (portable) | `Waypoint.0.3.0.exe` | 93 MB |
| macOS Intel | `Waypoint-0.3.0.dmg` | 118 MB |
| macOS Apple Silicon | `Waypoint-0.3.0-arm64.dmg` | 113 MB |
| Linux x64 (AppImage) | `Waypoint-0.3.0.AppImage` | 123 MB |
| Linux x64 (deb) | `waypoint-app_0.3.0_amd64.deb` | 83 MB |
| Linux arm64 (deb) | `waypoint-app_0.3.0_arm64.deb` | 78 MB |
| Android (debug APK) | `app-debug.apk` | 5.1 MB |
| VS Code | `waypoint-0.3.0.vsix` | 16 KB |

Linux notes: the AppImage is x64 only, because arm64 AppImages cannot be
cross-built reliably on an x64 runner. The `.deb` covers both architectures.

Android notes: the APK is **debug-signed**, so it installs for testing but is
not distributable through the Play Store. A release build needs a keystore
supplied as a repository secret; see
[the build guide](apps/desktop/BUILDING.md).

**These binaries are not code signed.** macOS Gatekeeper and Windows
SmartScreen will warn on first launch. See
[the build guide](apps/desktop/BUILDING.md).

### The VS Code extension

```bash
cd apps/vscode-extension
npm install && npm run build
npx @vscode/vsce package
code --install-extension waypoint-0.3.0.vsix
```

### The CLI

```bash
git clone https://github.com/Debarun1205/GearVane
cd GearVane
npm install
npm run build --workspace @gearvane/core
npm run build --workspace @gearvane/cli
node packages/cli/dist/bin.js --help
```

### Python

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
pip install -e .
gearvane --help
```

## Commands

Both CLIs implement the same commands:

| Command | Purpose |
|---------|---------|
| `gearvane route` | Show which tier would handle a prompt, without spending anything |
| `gearvane run` | Execute a prompt; `--stream` for token-by-token output |
| `gearvane health` | Probe every configured model against its real endpoint |
| `gearvane models` | List local models and which providers are running |
| `gearvane cost` | Cost and spend breakdown by tier and model |
| `gearvane stats` | Routing statistics for the session |
| `gearvane safety` | `spend`, `pending`, or `check --command "..."` |
| `gearvane approve` | Approve a gated operation |
| `gearvane deploy` | Run a deployment through the approval gate |
| `gearvane train` | Train the learned classifier from recorded outcomes |
| `gearvane dashboard` | Generate the HTML monitoring dashboard (Python) |

Add `--json` to any command for machine-readable output.

## Configure

Both engines look for `gearvane.yaml` (or `config.yaml`, or a `.json`
variant) in the working directory, then each parent directory, then your home
directory. Failing that they use built-in defaults, so nothing needs setting
up to try it.

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
  # Operations that require explicit approval. See: gearvane approve
  require_approval: [git_push, deploy_production, merge_pr]
  # Local models cost nothing, so there are no USD spend ceilings for
  # them: usage is tracked and reported by `gearvane cost`, never gated.
  # (The Python reference engine still accepts per-task/session/day
  # ceilings in this same file; the desktop app and TS CLI ignore them.)
```

`config.example.yaml` documents every key the code reads.

### API keys

Read from the environment, never from config:

```bash
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...
```

Local servers are never sent a key. See [SECURITY.md](SECURITY.md).

## How routing decides

Signals are scored into a tier, and every decision reports its reasons:

- **Task keywords** — `refactor` and `architecture` push toward frontier;
  `typo` and `formatting` toward local
- **Files touched** — glob or regex patterns, so `*.rs` and `src/core/*` both work
- **File count** — three or more files is a multi-file change
- **Error loops and test failures** — evidence the task is harder than it looked
- **Previous attempts** — a task that already failed here gets promoted

Failures feed back in, so escalation is driven by observed behaviour rather
than by the original guess.

Once you have recorded outcomes you can train the learned classifier, which
refines the choice but always defers to the heuristic on disagreement. See
`gearvane train`.

## Cost control

Budget is checked **before** tokens are spent, using the tier's
`cost_per_token`. A task that cannot fit the limit never reaches a provider.

```bash
gearvane safety spend
# Session: $2.31 / $7.69 remaining
```

## Safety

Commands pass through an allowlist. Anything not permitted needs approval,
and some never run at all:

```bash
gearvane safety check --command "git push origin main"
# pending  git_push  Operation 'git_push' requires approval

gearvane deploy github push        # refuses until approved
```

GearVane **does not sandbox** execution. It gates commands and relies on
your host environment for isolation.

## Development

```bash
npm install

npm run build          # all TypeScript packages
npm run test           # package tests
npm run test:repo      # site, gitignore, engine parity
npm run typecheck
npm run lint

python -m pytest tests/ -q    # Python suite
```

Current totals: 335 package tests, 55 repository tests, 461 Python tests.

CI runs the Python suite on 3.9 to 3.12, builds and tests every TypeScript
package, lints both trees, checks that the renderer bundle stays
self-contained, and asserts the two engines route identically.

## Building installers

Requires platform toolchains this repository does not carry. See
[apps/desktop/BUILDING.md](apps/desktop/BUILDING.md) for what builds where
and which artifacts are unsigned.

## Status

Alpha, and honest about it:

- The router, escalation, budget gates, provider clients, and CLIs are
  tested end to end.
- The learned classifier trains and predicts but has **not** been evaluated
  against real production traffic.
- Release binaries are **unsigned**, so Gatekeeper and SmartScreen will
  warn. The Android APK is debug-signed, not Play-Store ready.
- The harness gates destructive operations but does not sandbox them.
- Linux and Android artifacts are published on a best-effort basis; the
  Windows and macOS builds are the tested path.

## Licence

GearVane is MIT licensed ([LICENSE](LICENSE)).

Model weights are **not** covered by that licence. Each keeps its own terms —
MIT, Apache-2.0, Llama Community, Gemma, NVIDIA Open Model, Qwen, Falcon, and
others — and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists all 50 catalog weights
with their licence and a link to it. Only Apache-2.0 and MIT weights ship in
the installer; everything else is download-on-request, and the app shows the
licence beside the download before you accept it.