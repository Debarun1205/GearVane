# GearVane

**A local-first AI coding harness. It classifies what you asked for, runs it
through a tool-using agent loop with approvals and diff review, and picks the
cheapest tier that can do the job.**

```
              ┌──────────────────────────────────────┐
   prompt ──► │  classify → run → escalate on error   │
              └──────────────────┬───────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
   ┌─────────┐             ┌─────────┐             ┌───────────┐
   │  local  │             │   mid   │             │ frontier  │
   │  < 2 GB │             │ 2 - 6GB │             │   > 6 GB  │
   │ weights │             │ weights │             │  weights  │
   │  free   │             │  free   │             │   free    │
   └─────────┘             └─────────┘             └───────────┘
```

Two models are in the installer, offline, the moment you install. Two more
download on first launch in the background. The other 46 are one click away.
No account, no API key, and in Local-only mode nothing leaves your machine.
MIT licensed. **Alpha, and honest about it** — see [Status](#status).

## Why it is different

1. **Escalation on a check that failed, not a guess.** If a model errors or
   times out, the failure feeds the next decision and the task moves up a tier.
   More importantly, you can make it check the *answer* instead: point GearVane
   at your project's test command, and a run that fails the check is retried on
   a stronger tier with the failure output as context. That is the difference
   between a harness that knows the request was refused and one that knows the
   work was wrong.

   ```bash
   gearvane run --task "fix the failing parser test" --verify "npm test"
   ```

   Verification is opt-in, because only you know what "correct" means for your
   project. Without `--verify` nothing runs and the output says so.
2. **Auto routing with reasons.** Every decision lists the signals behind it —
   keywords, files touched, file count, error loops — so you can see why a tier
   was chosen and pin a different one. Try it on the
   [site](https://debarun1205.github.io/GearVane/#playground), where the real
   classifier runs in your browser.
3. **Free by default.** Two weights ship in the installer and two more arrive on
   first launch; the rest install when you pick them (under 500 MB silently,
   larger after you confirm). Local models cost nothing per token, and no
   spend limit is enforced on any model. A run through a keyed cloud model
   draws on your own key, and GearVane reports what it cost rather than gating
   it.
4. **Honest safety.** Writes are diff-reviewed, gated commands need an
   explicit approval, credential-shaped files are refused by default, and a
   file that tries to instruct the agent gets its subsequent writes held for a
   human. What it does *not* protect against is in
   [SECURITY.md](SECURITY.md).

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

The harness has workspace path containment, file tools, a gated shell,
tool-calling in the provider clients, an agent loop, context budgeting, and
session persistence. It is **not** a sandbox. See
[docs/harness-architecture.md](docs/harness-architecture.md), which a test
checks against the repository so its status table cannot drift.

## Install

From the [v0.3.0 release](https://github.com/Debarun1205/GearVane/releases/tag/v0.3.0).
Sizes and filenames below are the published assets, read from the releases
API:

| Platform | File | Size |
|----------|------|------|
| Windows x64 (installer) | `Waypoint.Setup.0.3.0.exe` | 93 MB |
| Windows x64 (portable) | `Waypoint.0.3.0.exe` | 93 MB |
| macOS Intel | `Waypoint-0.3.0.dmg` | 118 MB |
| macOS Apple Silicon | `Waypoint-0.3.0-arm64.dmg` | 113 MB |
| Linux x64 (AppImage) | `Waypoint-0.3.0.AppImage` | 123 MB |
| Linux x64 (deb) | `waypoint-app_0.3.0_amd64.deb` | 83 MB |
| Linux arm64 (deb) | `waypoint-app_0.3.0_arm64.deb` | 78 MB |
| Android (debug APK) | `app-debug.apk` | 5 MB |
| VS Code | `waypoint-0.3.0.vsix` | 16 KB |

**The filenames say Waypoint.** v0.3.0 was built before the rename, so the
artifacts still carry the old product name even though the app is GearVane.
The next release fixes that, and `tools/check-release-links.mjs` verifies on a
schedule that every link still resolves.

**These binaries are not code signed.** macOS Gatekeeper and Windows
SmartScreen will warn on first launch; on macOS, right-click the app and choose
Open, or run `xattr -d com.apple.quarantine /Applications/GearVane.app`. On
Windows, choose *More info* then *Run anyway*.

**Android** runs the same IDE — editor, file tree, search, Ask-mode agent —
over a workspace stored on the device. It has no terminal, because a webview
has no shell, and no file-changing Build mode, because the agent's tool layer
needs Node. The APK is **debug-signed**, so it installs for testing but is not
Play-Store distributable.

### Install from source

```bash
# The VS Code extension
cd apps/vscode-extension && npm install && npm run build
npx @vscode/vsce package && code --install-extension gearvane-0.3.0.vsix

# The TypeScript CLI
git clone https://github.com/Debarun1205/GearVane && cd GearVane
npm install
npm run build --workspace @gearvane/core
npm run build --workspace @gearvane/cli
node packages/cli/dist/bin.js --help

# Python
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt && pip install -e .
gearvane --help
```

## Models

<!-- BEGIN catalog-summary -->
**50 weights, 50 of them in the default tiers.**

2 ship in the installer (`qwen2.5-coder-0.5b-instruct-q4_0`, `smollm2-360m-instruct.q4_k_m`) and work offline at first
launch. The rest are one click away. Every one is a downloadable file you
run on your own machine, so a local run costs nothing and needs no
account. The catalog as a whole is
272.2 GiB if you wanted all of it; nobody does.
<!-- END catalog-summary -->

Weights under 500 MB install silently when you pick them; larger ones ask
first, showing the size, the licence, and whether it will fit your memory.

**Read the tier names as size bands, not a capability ranking.** `frontier`
means "the heaviest weights in the catalog" — a 4.7 GB model on your own
hardware. The tier a model lands in is read from the router's configuration,
and size does not predict it: `qwen3-8b` is in frontier at 4.7 GB while eleven
weights under 2 GB sit in mid. Tiering by measured capability is not done yet,
and the app says so next to the picker.

<!-- BEGIN catalog-table -->
| Model | Tier | Size | Licence | In installer |
| --- | --- | --- | --- | --- |
| `qwen2.5-coder-0.5b-instruct-q4_0` | `local` | 0.4 GiB | Apache-2.0 | yes |
| `smollm2-360m-instruct.q4_k_m` | `local` | 0.3 GiB | Apache-2.0 | yes |
| `qwen2.5-1.5b-instruct-q4_0` | `local` | 1.0 GiB | Apache-2.0 | no |
| `llama-3.2-1b-instruct-q4_k_m` | `local` | 0.8 GiB | custom | no |
| `llama-3.2-3b-instruct-q4_k_m` | `local` | 1.9 GiB | custom | no |
| `gemma-2-2b-it-q4_k_m` | `local` | 1.6 GiB | custom | no |
| `deepseek-r1-distill-qwen-1.5b-q4_k_m` | `local` | 1.0 GiB | MIT | no |
| `qwen2.5-coder-1.5b-instruct-q4_0` | `local` | 1.0 GiB | Apache-2.0 | no |
| `qwen2.5-coder-3b-instruct-q4_0` | `local` | 1.9 GiB | custom | no |
| `smollm2-1.7b-instruct.q4_k_m` | `local` | 1.0 GiB | Apache-2.0 | no |
| `qwen3-0.6b.q4_k_m` | `local` | 0.5 GiB | Apache-2.0 | no |
| `tinyllama-1.1b-chat-v1.0.q4_k_m` | `local` | 0.6 GiB | Apache-2.0 | no |
| `deepseek-coder-1.3b-instruct.q4_k_m` | `local` | 0.8 GiB | custom | no |
| `falcon3-3b-instruct-q4_k_m` | `local` | 1.9 GiB | custom | no |
| `phi-3-mini-4k-instruct-q4` | `mid` | 2.2 GiB | MIT | no |
| `qwen2.5-3b-instruct-q4_0` | `local` | 1.9 GiB | custom | no |
| `qwen2.5-0.5b-instruct-q4_0` | `local` | 0.4 GiB | Apache-2.0 | no |
| `qwen2.5-7b-instruct-q4_k_m` | `mid` | 4.4 GiB | Apache-2.0 | no |
| `mistral-7b-instruct-v0.3-q4_k_m` | `mid` | 4.1 GiB | Apache-2.0 | no |
| `deepseek-r1-distill-qwen-7b-q4_k_m` | `mid` | 4.4 GiB | MIT | no |
| `falcon3-7b-instruct-q4_k_m` | `mid` | 4.3 GiB | custom | no |
| `qwen2.5-coder-7b-instruct-q4_0` | `mid` | 4.1 GiB | Apache-2.0 | no |
| `falcon3-1b-instruct-q4_k_m` | `local` | 1.0 GiB | custom | no |
| `qwen3-1.7b.q4_k_m` | `local` | 1.2 GiB | Apache-2.0 | no |
| `starcoder2-7b-q4_k_m` | `mid` | 4.1 GiB | custom | no |
| `qwen3-4b.q4_k_m` | `mid` | 2.5 GiB | Apache-2.0 | no |
| `starcoder2-3b-q4_k_m` | `local` | 1.7 GiB | custom | no |
| `qwen2.5-14b-instruct-q4_k_m` | `frontier` | 8.4 GiB | Apache-2.0 | no |
| `deepseek-r1-distill-qwen-14b-q4_k_m` | `frontier` | 8.4 GiB | MIT | no |
| `mistral-nemo-instruct-2407-q4_k_m` | `frontier` | 7.0 GiB | Apache-2.0 | no |
| `falcon3-10b-instruct-q4_k_m` | `mid` | 5.9 GiB | custom | no |
| `qwen2.5-coder-14b-instruct-q4_k_m` | `frontier` | 8.4 GiB | Apache-2.0 | no |
| `qwen3-8b.q4_k_m` | `frontier` | 4.7 GiB | Apache-2.0 | no |
| `starcoder2-15b-q4_k_m` | `frontier` | 9.2 GiB | custom | no |
| `phi-4-q4_k` | `frontier` | 8.4 GiB | MIT | no |
| `meta-llama-3.1-8b-instruct-q4_k_m` | `mid` | 4.6 GiB | custom | no |
| `gemma-2-9b-it-q4_k_m` | `mid` | 5.4 GiB | custom | no |
| `phi-3.5-mini-instruct-q4_0` | `mid` | 2.0 GiB | MIT | no |
| `qwen2.5-32b-instruct-q4_k_m` | `frontier` | 18 GiB | Apache-2.0 | no |
| `qwen2.5-coder-32b-instruct-q4_k_m` | `frontier` | 18 GiB | Apache-2.0 | no |
| `yi-1.5-34b-chat-q4_k_m` | `frontier` | 19 GiB | Apache-2.0 | no |
| `qwen3-30b-a3b-q4_0` | `frontier` | 16 GiB | Apache-2.0 | no |
| `nvidia-nemotron3-nano-4b-q4_k_m` | `mid` | 2.6 GiB | custom | no |
| `qwen3-coder-30b-a3b-instruct-q4_0` | `frontier` | 16 GiB | Apache-2.0 | no |
| `mistral-small-3.1-24b-instruct-2503-q4_k_m` | `frontier` | 13 GiB | Apache-2.0 | no |
| `qwen3-14b-q4_k_m` | `frontier` | 8.4 GiB | Apache-2.0 | no |
| `gemma-3-12b-it-q4_k_m` | `frontier` | 6.8 GiB | custom | no |
| `gemma-3-12b-it-q4_0` | `frontier` | 6.4 GiB | custom | no |
| `deepseek-r1-distill-qwen-32b-q4_k_m` | `frontier` | 18 GiB | MIT | no |
| `deepseek-r1-distill-llama-8b-q4_k_m` | `mid` | 4.6 GiB | custom | no |
<!-- END catalog-table -->

**The catalog's RAM figures are hand-written prose, and they contradict each
other.** 29 of the 50 entries say "needs NGB RAM" inside their description, the
ratio to file size ranges from 1.73x to 3.48x, and one entry claimed 48 GB for a
15 GiB file while another claimed 32 for an 18 GiB one. Treat them as hints,
never as requirements.

**Every weight's size, revision and SHA-256 come from the Hugging Face API, and
all 50 install with one click.** Previously thirteen entries carried byte counts
that disagreed with the published file, and seven named repositories that
returned 401 or did not contain the file — one of them a 67 GiB weight behind
`bartowski/DeepSeek-V3-GGUF`, which no longer resolves. Those are replaced with
verified weights under 20 GiB, not marked remote. `tools/check-catalog-pins.mjs`
fails on any entry not pinned to a commit revision with a hash.

So the app does not use them to decide anything. It measures the machine
instead: **os.totalmem**, **os.freemem**, and **statfs** on the volume holding
the model directory, read in the main process because the renderer is sandboxed.
One rule is arithmetic rather than an estimate — weights are memory-mapped, so a
weight larger than physical RAM cannot load, whatever else is running. Above
that floor the app adds a stated 1.3x overhead factor and calls it an estimate,
because the KV cache scales with context length and quantization in ways the
catalog does not record. Tokens per second is still not shown, because nothing
in this repository measures it.

The onboarding wizard reports the figures and which weights fit; the install
confirmation for anything over 500 MB reports them before you commit the
download. Where the app cannot measure — the Android webview has no filesystem
to read — both say so instead of showing zeros.

## Use it

**The app.** Install, pick a routing posture, and go. The picker pins the
next run to any catalog model or leaves it on Auto; every decision shows its
reasons, and the run readout names the tier and model that answered.

**The CLI.** Both engines implement the same commands:

```bash
# What would handle this, without spending anything
gearvane route --task "Fix the typo in README.md" --files README.md

# Run it, streaming
gearvane run --task "Investigate a race condition in the cache writer" --stream

# Is this command gated?
gearvane safety check --command "git push origin main"
```

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
| `gearvane feedback` | Show or record routing outcomes |
| `gearvane train` | Train the learned classifier from recorded feedback |
| `gearvane dashboard` | Generate the HTML monitoring dashboard (Python) |

Add `--json` to any command for machine-readable output.

**VS Code.** The extension exposes routing and chat from the editor, with ghost
text completions from a local model — local only by design, so completions
never leave your machine.

## How routing decides

Signals are scored into a tier, and every decision reports its reasons:

- **Task keywords** — `refactor` and `architecture` push toward frontier;
  `typo` and `formatting` toward local
- **Files touched** — glob or regex patterns, so `*.rs` and `src/core/*` both work
- **File count** — three or more files is a multi-file change
- **Error loops and test failures** — evidence the task is harder than it looked
- **Previous attempts** — a task that already failed here gets promoted

The learned classifier exists, trains from recorded feedback, and always
defers to the heuristic on disagreement. Both the CLI and the desktop app
record outcomes, in the same `feedback.jsonl` format, so `gearvane train`
works on runs made in either. Training and loading the trained model are
CLI-only, so inside the desktop app routing stays on the heuristic.

## Configure

Both engines look for `gearvane.yaml` (or `config.yaml`, or a `.json` variant)
in the working directory, then each parent directory, then your home directory.
Failing that they use built-in defaults, so nothing needs setting up to try it.

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
  # Local models cost nothing, so there are no USD ceilings for them:
  # usage is tracked and reported by `gearvane cost`, never gated. Ceilings
  # apply to hosted models, which are the runs that bill you.
```

`config.example.yaml` documents every key the code reads.

### API keys

Read from the environment, never from a config file. In the desktop app the
Keys dialog stores them in a vault the main process encrypts through your
operating system's secret store — DPAPI, Keychain, or libsecret — so the file
on disk is ciphertext only your login can open. Where the platform has no
secret store, keys stay in memory for that session and the app says so rather
than writing plaintext. Local model servers are never sent a key.

## Safety

Commands pass through an allowlist. Anything not permitted needs approval,
and some never run at all:

```bash
gearvane safety check --command "git push origin main"
# pending  git_push  Operation 'git_push' requires approval
```

A command with no shell metacharacters runs with `execFile` and no shell at
all, so the string that was checked is the argv that runs. Compound commands
go through a shell with the exact string that was checked, and an allowlist
entry matches a command exactly — `git status; git push` never rides the
`git status` entry past the push gate. Nested interpreters (`bash -c`,
`cmd /c`, `-EncodedCommand`) always require approval, because the shell
re-parses their argument into something the gate never saw.

## Cost control

**No spend limit is enforced on you, for any model.** Per-task, per-session and
per-day USD ceilings were removed: they were never enforced by the TypeScript
engine, the Python engine checked a different set of numbers, and a ceiling on a
local model is a ceiling on zero.

Cost class is derived from the provider, not from the tier. A run costs money
only if reaching the model needed a key that belongs to somebody else, so the
local tier and the local weights sitting inside the mid and high tiers all read
as free:

```bash
gearvane safety spend
# local     unlimited, $0.00  (embedded, ollama, lm_studio, llama_cpp, vllm, ...)
# mid       metered, $0.0001/token  (free: embedded | metered: openrouter, meta, ...)
# frontier  metered, $0.005/token  (free: embedded | metered: anthropic, openai, ...)
#
# No spend limits are enforced, for any model.

gearvane cost
# Calls: 12
# Tokens: 8,104 in / 1,902 out
# Cost:   $0.0041
```

Add `--json` to either for machine-readable output. The meter in the app shows
what a session has cost against a keyed provider, and nothing cuts the run off
behind it.

Run safety is bounded by safeguards rather than budgets: max iterations, a
per-run timeout, repeat-call detection, and a kill switch. All four are
adjustable, and none of them counts runs, tokens or time per day.

Read tools refuse credential-shaped paths even inside the workspace: `.env`
variants, `.ssh/`, `.aws/`, `.git/config`, private keys, browser cookie and
password stores, and package-registry auth files. Each can be granted for a
single run, per path, with no wildcard.

GearVane **does not sandbox** execution. It gates commands and relies on your
host environment for isolation.

## Development

```bash
npm install

npm run build          # all TypeScript packages
npm run test           # package tests
npm run test:repo      # site, README, engine parity, catalog drift
npm run test:python    # Python suite
npm run typecheck
npm run lint

node tools/gen-site-catalog.mjs   # refresh the site's model table
node tools/gen-readme-tables.mjs  # refresh the README model table
```

Those two generators have `--check` modes, and CI runs them, so a stale table
fails the build rather than quietly misreporting the catalog.

CI runs the Python suite on 3.9 through 3.12, builds and tests every
TypeScript package, lints both trees, runs the end-to-end Electron suite on
Linux, Windows, and macOS, checks that the renderer bundle stays
self-contained, scans history for secrets, and asserts the two engines route
identically.

## Building installers

Requires platform toolchains this repository does not carry. See
[apps/desktop/BUILDING.md](apps/desktop/BUILDING.md).

**The installer carries two weights, not the catalog.** Two models are flagged
`bundled` in `src/models.json` — SmolLM2 360M (258 MB) and Qwen2.5-Coder 0.5B
(409 MB), both Apache-2.0 — for 0.65 GiB together. Two more are flagged
`first-boot`: Qwen2.5 7B and Qwen3 8B, 9.0 GiB, fetched on first launch with
resume, retry and a SHA-256 check. That split is what keeps the installer under
the 2 GiB per-asset limit GitHub enforces on release uploads.

`extraResources` names each of those two files rather than the
`resources/models` directory, so a build machine that happens to have other
weights on disk cannot fold them into the artifact. That directory is
gitignored, so CI always started empty and produced a correct installer while a
local `npm run dist` shipped everything the developer had downloaded — which is
where an earlier 9.7 GiB measurement came from.

`models:fetch` takes `--first-boot` for the two the app provisions and `--all`
for the whole catalog. `--first-run` used to mean `--all`; it now exits with an
error, because a flag called "first run" in a build script is one refactor away
from downloading every weight on a user's first launch.

## Status

Alpha, and honest about it:

- The router, escalation, budget gates, provider clients, and both CLIs are
  tested end to end.
- **Verification is real but narrow.** A failed check retries on a stronger tier
  with the failure output in the prompt, and a check that could not run returns
  `unknown` rather than being treated as a pass or a failure. It runs your
  command through the safety gate, so a command needing approval reports that
  instead of running. The limits: it is opt-in per run rather than configured
  once, the desktop app does not yet offer a verifier, and a verifier that
  cannot tell is reported honestly rather than guessed at.
- **Escalation also fires on a model or provider error**, which is the older
  and cruder signal. The two are independent: a transport failure and a failed
  check both promote a task.
- Tier assignment is provisional and size-influenced, not measured. No
  benchmark exists yet.
- Tokens per second is not shown in the app and is not measured anywhere in
  this repository. RAM fit *is* measured from the machine, rather than
  estimated from the catalog's inconsistent hints, but that is a fit check and
  not a speed claim.
- The learned classifier trains and predicts but has **not** been evaluated
  against real production traffic. Both the CLI and the desktop app now record
  outcomes, but only the CLI loads a trained model, so the app still routes on
  the heuristic.
- Release binaries are **unsigned**; the Android APK is debug-signed and not
  Play-Store ready.
- The harness gates destructive operations but does not sandbox them.
- Provider support is tested against fixtures and mocks. No provider has been
  verified live, because that needs credentials this project does not have.

## Licence

GearVane is MIT licensed ([LICENSE](LICENSE)).

Model weights are **not** covered by that licence. Each keeps its own terms —
MIT, Apache-2.0, Llama Community, Gemma, NVIDIA Open Model, Qwen, Falcon,
DeepSeek, and BigCode among them — and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists all 50 catalog weights
with their licence and a link to it. Only Apache-2.0 and MIT weights ship in
the installer; everything else is download-on-request, and the app shows the
licence before you accept one.