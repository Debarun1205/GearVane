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
| Tool call **advertising** to a provider | **not done** |
| Agent loop | **not done** |
| Agent loop | **not done** |
| Context management | **not done** |
| Session persistence | **not done** |
| Shell containment and sandboxing | **not done** |

Path containment and sandboxing are separate rows on purpose. File paths are
confined today. Command execution is not: the shell tool does not exist, so
there is nothing confining it yet. Collapsing the two into one row would let
"sandboxed" be written next to a feature that only protects files.

The last two rows are the same bug seen twice: `Completion.toolCalls` is
populated by `normaliseToolCalls`, so the plumbing to *read* a tool call
exists, but no code path ever sends a `tools` parameter to a model. A model
that is never told what tools exist cannot ask to use one. The harness cannot
work until that is closed.

## Layering

New code goes in `packages/harness`, which depends on `@waypoint/core` and
does not get folded into it. Core stays the routing layer so the Python parity
test keeps comparing like with like.

```
packages/harness
  tools/        tool schemas, registry, dispatch
  tools/fs      read, write, edit, list, glob, grep
  tools/shell   command execution, gated by core's SafetyManager
  workspace/    path containment
  agent/        the loop
  context/      token budget, history, compaction
  session/      persist and resume
```

Dependency direction is strictly downward: `agent` may use `tools`, `tools`
may use `workspace`, and `workspace` may use nothing from this package.

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

What exists today is the file half. `Workspace` in `packages/harness` resolves
every path against a root and re-checks the *real* path, so `..`, absolute
paths, and symlinks pointing out of the tree are all rejected. What does not
exist is the command half, so the remaining requirements are:

- reads have a size cap so a model cannot pull a whole disk into its context
- writes require the parent directory to exist or be created explicitly
- the shell tool runs through `SafetyManager` with its working directory pinned
  to the workspace, and cannot be talked out of that by the command string

Until the command half is built, the honest statement is that the harness has
file containment and **no sandbox**. The README says so, and a test asserts it
keeps saying so.

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