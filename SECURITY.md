# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Use GitHub's private vulnerability reporting on this repository, or open a
security advisory.

Include a description, reproduction steps, and the version or commit you
tested. You should get an acknowledgement within a few days.

## Credential handling

GearVane never writes a credential to a config file, a log, or a dashboard.

### Keys you bring

Desktop keys live in an OS-encrypted vault, not in browser storage. The main
process owns the file and encrypts it through Electron `safeStorage`, so what
lands on disk is DPAPI, Keychain, or libsecret ciphertext that only your login
can open. Where the platform has no secret store — a Linux box with no keyring
daemon — keys are kept in memory for the session and the app says so rather
than quietly falling back to plaintext.

The renderer still holds a key in memory while a hosted run is in flight,
because it has to know which providers are keyed and hand the value to the
agent IPC. This is encryption at rest, not containment.

Providers resolve keys in this order:

1. the `api_key_env` variable named for that provider
2. `<PROVIDER>_API_KEY` in the environment
3. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` as a fallback

Local servers (Ollama, LM Studio, llama.cpp, vLLM) are forced to
`api_key=None` regardless of the environment, since they do not
authenticate.

`config.example.yaml` contains no credentials. `config.yaml` is
gitignored, but do not put secrets in it anyway — use the environment.

### Files the agent refuses to read

Containment answers "is this path inside the project". It does not answer
"should this be read", and projects contain secrets by accident often enough
that the question has to be asked separately: a `.env` committed before
someone added `.gitignore`, a `service-account.json`, a `server.key` from a
tutorial.

So the read tools refuse credential-shaped paths by default, even well inside
the workspace:

- `.env` and `.env.local`-style files — but not `.env.example` and friends,
  which exist to be committed
- `.ssh/`, `.aws/`, `.gnupg/`, `.kube/`, `.azure/`, `.gcloud/`, `.docker/`
- `.git/config`, which can carry a token in a push URL
- private keys and keystores: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
  `*.keystore` — files named `public*` are exempt
- browser profiles: `Login Data`, `cookies`, `key4.db`, and the Chrome,
  Firefox, Edge, and Brave profile directories
- `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, and files named
  `credentials`, `secrets.json`, `id_rsa`, `wallet.dat`

Search withholds the same files and says how many it withheld, rather than
returning nothing and reading as "no match". Every refusal can be granted for
a single run by the user; there is no wildcard, so approving `.env` does not
open `.env.production`.

This is a list of path shapes, not a scanner. A secret named `config.txt`
still gets through. Treat it as one layer, not a guarantee.

## Git credentials

Do not embed a personal access token in a remote URL:

```
git remote set-url origin https://github.com/Debarun1205/GearVane.git   # good
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

GearVane is an alpha routing harness. It does not sandbox shell execution;
it gates commands and relies on your host environment for isolation. Run it
only where you would be comfortable running the commands it approves.