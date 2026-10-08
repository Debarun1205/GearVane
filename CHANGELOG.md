# Changelog

All notable changes to GearVane are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-10-08

### Fixed
- **Desktop Packaging in CI**: Configured `npmRebuild: false` in `electron-builder` configuration for `gearvane-app` to prevent redundant production re-install and native toolchain rebuild failures in CI runners, enabling automated generation and publishing of desktop installers (`.exe`, `.AppImage`, `.deb`, `.dmg`).

## [0.4.0] - 2026-10-08

### Added
- **50-Model Catalog**: Single source of truth in `models.json` with 50 verified, pinned GGUF model weights hosted on Hugging Face, pinned to exact 40-character commit SHAs with SHA-256 integrity hashes.
- **First-Boot Provisioning**: The desktop installer bundles 2 low-tier weights (`smollm2-360m`, `qwen2.5-coder-0.5b`, ~0.65 GiB) for immediate offline readiness, and provisions 2 more (`qwen2.5-7b`, `qwen3-8b`, ~9.04 GiB) automatically in the background on first launch with progress reporting, pause, and resume.
- **500 MiB Download Guard**: Models under 500 MiB install silently upon selection; models 500 MiB or larger prompt with memory fit, size, and license verification before transfer.
- **Eigent-Style Shell**: Spaces dashboard with Activity Hub for tracking parallel agent executions, Sessions, Skills, Connectors (MCP dialog with JSON schema validation), and streaming split-view run details.
- **Verification-Driven Escalation**: Opt-in `--verify <command>` in CLI to retry stronger model tiers when test/lint checks fail.
- **B5 Benchmarking CLI**: `tools/bench.mjs` for measuring time-to-first-token (TTFT), tokens/s, and completion latency.
- **Hardware-Aware Manager**: Real hardware measurement (`os.totalmem`, `os.freemem`, filesystem disk checks) to guide model fitting and prevent OOM loading failures.

### Changed
- **Zero Spend Limits**: Removed artificial budget ceilings and `spend_limits` enforcement. Local models are marked "Free, unlimited". Non-blocking cost meter displayed for keyed cloud providers.
- **Upgraded Electron**: Electron updated from 33.4.11 to 44.5.1, resolving 72 Dependabot security vulnerabilities.
- **Upgraded Testing Stack**: Vitest updated to 3.2.7 and Playwright updated to 1.63.0.
- **Sequenced Builds**: Monorepo root build script executes workspaces in strict topological dependency order.

### Security
- **Pinned Actions**: All 14 third-party GitHub Actions across CI/CD workflows are pinned to full 40-character commit SHAs with `permissions: contents: read` baseline.
- **Keyring Vault**: Model API keys stored via OS keyring (`safeStorage`) instead of plain local storage.
- **Credential Path Protection**: Deny-list blocking reading `.env`, `.ssh`, and secret-shaped files by default.
- **Loopback Hardening**: Embedded inference server binds to loopback with per-launch bearer token.
- **Dependency Audit**: Eliminated 83 Dependabot alerts (down to 19 total, with 0 unmitigated runtime vulnerabilities in core harness code).

### Removed
- Deprecated spend-limit configurations and obsolete mock size tables.
- Legacy `waypoint-*` unmanaged temporary directories and scratch remnants.

### Known Limitations
- Binaries are unsigned (macOS Gatekeeper and Windows SmartScreen require bypass on first run).
- Android build provides IDE workspace management without a native shell terminal and cannot run local model weights.

## [0.3.0] - 2026-10-03

### Added
- Standalone desktop application with embedded Monaco editor and agent harness.
- Device-local workspace mounting.
- Initial model catalog and tier routing engine.
- VS Code extension and Android webview preview.

## [0.2.0] - 2026-09-28

### Added
- Tier routing engine that sends each prompt to the cheapest model that can do the job.
- TypeScript engine (`packages/core`) with the Python implementation retained as reference.
