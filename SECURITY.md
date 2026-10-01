# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Use GitHub's private vulnerability reporting on this repository, or open a
security advisory.

Include a description, reproduction steps, and the version or commit you
tested. You should get an acknowledgement within a few days.

## Credential handling

Waypoint reads API keys from environment variables only. It never writes a
credential to a config file, a log, or a dashboard.

Providers resolve keys in this order:

1. the `api_key_env` variable named for that provider
2. `<PROVIDER>_API_KEY` in the environment
3. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` as a fallback

Local servers (Ollama, LM Studio, llama.cpp, vLLM) are forced to
`api_key=None` regardless of the environment, since they do not
authenticate.

`config.example.yaml` contains no credentials. `config.yaml` is
gitignored, but do not put secrets in it anyway — use the environment.

## Git credentials

Do not embed a personal access token in a remote URL:

```
git remote set-url origin https://github.com/Debarun1205/Waypoint.git   # good
git remote add origin https://x-access-token:<TOKEN>@github.com/...      # bad
```

The second form stores the token in plaintext in `.git/config` and passes
it through shell history and process listings. Use a credential helper
instead:

```bash
git config --global credential.helper manager
```

Git Credential Manager (bundled with Git for Windows and macOS) stores
credentials in the OS credential store. On Linux use `libsecret`:

```bash
git config --global credential.helper 'store --file ~/.git-credentials'
```

If a token has been in a remote URL, treat it as compromised and rotate
it.

## Approval gates

Operations listed under `safety.require_approval` do not run until a
human approves them. The gates cover `git_push`, `git_force_push`,
`merge_pr`, `delete_branch`, and `deploy_production`.

Two behaviours are load-bearing:

- A gated operation is refused even under `--dry-run`. Dry run previews
  the command; it does not bypass the gate.
- A command an agent wants to run is checked in the same form that will
  actually execute. If the checked string and the executed string differ,
  the gate can be bypassed. This was a real bug and is covered by a test.

Commands matching `safety.blocked_commands` never run, approved or not.
Do not weaken `blocked_commands` without reading what it currently blocks.

## Out of scope

Waypoint is an alpha routing harness. It does not sandbox shell execution;
it gates commands and relies on your host environment for isolation. Run it
only where you would be comfortable running the commands it approves.