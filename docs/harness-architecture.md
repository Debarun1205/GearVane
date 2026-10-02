# Harness architecture

The intent for Waypoint is a complete AI harness: an agent that reads a task,
decides which tools it needs, runs them, observes the results, and keeps going
until the task is done or it is genuinely stuck.

This document describes how that gets built on top of what already exists, and
is honest about what does not exist yet.

## What exists today

Waypoint is currently a **routing engine**. It classifies a task into a tier,
runs the cheapest model that plausibly works, escalates on real failure, and
tracks spend. That is real, tested infrastructure, and it is the layer a
multi-model harness needs most and usually gets wrong.

| Area | State |
|------|-------|
| Provider clients (OpenAI-compatible, Ollama, Anthropic-shaped) | done |
| Retry, health checks, escalation | done |
| Cost tracking and budget gates | done |
| CLI, Electron app, VS Code extension, Android app | done |
| Tool call **parsing** from a provider response | done |
| Workspace path containment for file tools | done |
| Tool layer: schema, validation, registry, dispatch | done |
| File tools: read, write, edit, list, mkdir | done |
| Tool call **advertising** to a provider (OpenAI-compatible, Anthropic) | done |
| Agent loop | done |
| Context management | **not done** |
| Session persistence | **not done** |
| Shell tool: gated, cwd-pinned, bounded | done |
| Sandboxing (OS-level containment) | **not done, and not planned here** |

The last two rows are separate on purpose, and the distinction is the most
important one in this document.

The shell tool exists. It gates commands through `SafetyManager`, refuses
blocked commands outright, pins the working directory to the workspace, strips
provider credentials from the child environment, and bounds runtime and output.
That is a meaningful improvement over running whatever a model prints.

**It is not a sandbox.** A user who approves `curl https://example.com` has
allowed a process that can read every file they can read. Pinning `cwd` does
not change that, and neither does an allowlist. Real containment needs an OS
boundary: a container, a Windows job object, seccomp, or a VM. None of those is
implemented, and `tests/harness-docs.test.ts` fails if this document or the
tool's own source ever stops saying so.

Writing "sandboxed" next to a gated shell would be the most dangerous single
sentence in this repository, because a reader would reasonably conclude that a
misbehaving command cannot reach their files.

Tool calling was once the same bug in two places: `Completion.toolCalls` is
populated by `normaliseToolCalls`, so the plumbing to *read* a tool call
existed, but no code path ever sent a `tools` parameter to a model. A model
that is never told what tools exist cannot ask to use one, so every tool call
would have been permanently empty. Both halves are now implemented and tested
against the wire format of each provider.

The two providers disagree on the details, which is why the wire format is
tested rather than assumed:

- OpenAI-compatible takes `{type, function}` and returns `tool_calls` with
  JSON-string arguments.
- Anthropic takes a bare function object with `input_schema`, returns
  `tool_use` content blocks, and sends a tool result back as a **user** turn
  carrying `tool_result`, not as a `tool` role. It also requires strict
  role alternation, so two tool results in a row have to be merged.

## Layering

New code goes in `packages/harness`, which depends on `@waypoint/core` and
does not get folded into it. Core stays the routing layer so the Python parity
test keeps comparing like with like.

```
packages/harness
  index.ts      the agent loop, runAgent()
  tools/        tool schemas, validation, registry, dispatch
  tools/fs      read, write, edit, list, mkdir
  tools/shell   command execution, gated by core's SafetyManager
  workspace/    path containment
  context/      token budget, history, compaction                 [not built]
  session/      persist and resume                                [not built]
```

The loop lives at the package root rather than in `agent/` because it is the
only thing a caller needs to import.

Dependency direction is strictly downward: the loop may use `tools`, `tools`
may use `workspace`, and `workspace` may use nothing from this package. The
shell tool is the one place that reaches outward, to `SafetyManager` in core,
and it does so through the narrow `check`/`approve` surface rather than by
taking the whole config.

## The agent loop

```
messages = [system, user task]
loop up to maxIterations:
  completion = provider.complete(messages, tools)
  if completion.toolCalls is empty: return completion.content
  for each call:
    result = registry.execute(call)
    messages.append(assistant tool call, tool result)
```

The loop must stop on a real condition rather than on a token ceiling alone:
no tool calls, a repeated identical call, an iteration limit, or an
unrecoverable error. A loop that only stops when it runs out of budget is a
loop that will happily spend a session budget being wrong.

## Containment

This is the part that becomes critical rather than cosmetic once an agent can
write files and run commands.

Gating is not containment. Asking "may I run this command?" does not stop a
command that was already allowed from touching anything on the machine.

What exists covers both halves, with one honest limit.

File paths: `Workspace` resolves every path against a root and re-checks the
*real* path, so `..`, absolute paths, null bytes, and symlinks pointing out of
the tree are all rejected. Reads are byte-capped so a model cannot pull a whole
disk into its context. Writes require the parent directory to exist.

Commands: the shell tool runs through `SafetyManager`, refuses blocked
commands, pins `cwd` to the workspace root, passes a curated environment
rather than the parent's, and bounds both runtime and captured output. Approval
is required for consequential operations, and with no approver configured a
gated command fails rather than proceeding unattended.

The limit: none of this is containment. The child process is not confined to
the workspace, only started there. `cwd` affects relative path resolution, not
what the process can open. A command that was approved can read and write
anywhere the user can, and an approval prompt does not change that.

So the accurate statement is: **the harness confines file operations by
construction, and gates command execution by policy.** Closing the remaining
gap needs an OS boundary — a container, a Windows job object, seccomp, or a
sandbox VM — which is not implemented. The README says so and a test asserts
it keeps saying so.

### A failure worth recording

The first implementation killed a timed-out command with `child.kill()`, which
kills the direct child. With `shell: true` the direct child is the shell, not
the command, so on Windows the real process survived and kept the inherited
stdout and stderr pipes open. `close` never fired, the promise never settled,
and a timed-out command **hung the agent instead of stopping it**.

The fix kills the process tree (`taskkill /T /F` on Windows, a negative pid on
POSIX) and settles on a grace timer rather than trusting `close`. It was found
by measuring the running behaviour — no `close` event within three seconds —
rather than by reasoning about it. Tests cover both the prompt settling and
the case where output had already arrived before the process hung.

## Multi-model

The point of the harness is that the routing engine is in the loop, not bolted
on afterwards. Cheap work should reach a local model and a hard reasoning task
should escalate, and the agent loop is where those decisions actually have
cost consequences.

Two things follow from that:

- Every iteration reports tokens and cost, because a tool-using loop spends
  far more per task than a single completion.
- Tool calling is not universally supported. The local tier may not do it at
  all, so the harness needs a documented path for a tier that cannot use tools,
  rather than assuming it.

## Status

Alpha, and deliberately incomplete in public. The table at the top of this
document is the source of truth; when it changes, it changes in the same
commit as the code.