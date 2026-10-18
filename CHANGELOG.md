# Changelog

All notable changes to GearVane are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-10-18

The first release of the 0.4 line that ships installers. v0.4.0 was published
without any (its desktop build failed, and the old publish step released anyway),
so this release carries everything from 0.4.0 plus the fixes below.

### Fixed
- **The installer carried one file where the app expects a directory of two.** Each bundled weight was copied to `models`, which electron-builder treats as a destination directory only when it already exists. The first weight was therefore written as a file called `models` and the second overwrote it, so the bundled models could not load in any installed build. Each weight now has an explicit destination path.
- **Model downloads went into the install folder.** First-boot provisioning and every one-click install wrote to `resources/models`, which is read-only for an AppImage and a `.deb`, re-extracted on every launch for the portable Windows build, and inside the app bundle on macOS. Installed builds now download to the per-user data folder; the weights shipped in the installer are served from where they are, and the picker counts them as installed.
- **The release pipeline published incomplete releases.** The publish step ran if either the desktop or the VS Code job succeeded, so a failed desktop build with a passing extension released a page holding one file. A release is now created as a draft, checked for every expected installer (named for this version, each under GitHub's 2 GiB limit), given `SHA256SUMS.txt`, and published only after the uploaded files are counted. A failed run leaves an invisible draft.
- **Every manifest still said 0.3.0.** v0.4.0 was tagged with all version strings at 0.3.0, so its installers would have carried the wrong name. A preflight job now compares the tag with every version string (manifests, lockfile, the TypeScript and Python constants, the README's VSIX name) before anything is built; `tools/versions.mjs` sets them together.
- **`models:fetch` re-downloaded weights it already had.** The check hashed a file but compared the unfinished result, so a correct file was judged bad, deleted, and fetched again on every run. A complete `.part` left by an interrupted run is now verified and kept instead of asking the server for a range past the end, and a size mismatch reports the real sizes instead of a missing-file error.
- **Unpackaged runs started the 9 GiB first-boot download.** Every end-to-end test and every `npm start` began fetching real weights into a temporary folder and was then killed, leaving gigabytes behind. Only installed builds provision now (`GEARVANE_PROVISION=1` opts a source run in).
- **Native modules are unpacked explicitly.** `node-llama-cpp` and `node-pty` are listed in `asarUnpack`, so their binaries are outside the archive where they can be loaded. The rebuild step stays disabled (`npmRebuild: false`) so CI does not recompile them.

### Added
- **Release checks that inspect the packaged output** (`tools/verify-packaged.mjs`): `resources/models` is a directory holding both bundled weights at their catalog sizes, the app archive contains the main process, the renderer and the workspace packages, and the native inference binary is unpacked.
- **A packaged-app smoke test** (`apps/desktop/e2e/packaged.pw.ts`) that launches the installed executable and asks the bundled model for a reply. Advisory until it has been seen passing on all three platforms.
- **Release notes come from this changelog** (`tools/release-notes.mjs`), followed by install instructions for unsigned builds.

### Changed
- **macOS is Apple Silicon only; the `.deb` is x64 only.** The embedded model runtime and the terminal are native, and `npm ci` installs the binary for the build machine's own architecture, so an Intel Mac image or an arm64 `.deb` built on these runners would launch with no working local model. They return with native runners for those architectures.
- Release assets are listed without the macOS `.zip`, and spaces in file names become dots, so the names in `SHA256SUMS.txt` match the download names.

### Known issues
- None of the builds are code signed (Windows SmartScreen and macOS Gatekeeper warn on first launch; the release notes say how to proceed).
- This release has not yet been confirmed by an install on a clean machine; the packaged smoke test is advisory.
- Tiers in the picker are size bands, not measured capability, and the IDE agent does not yet route with Auto.
- Some Dependabot alerts remain, mostly transitive through `electron-builder` and `node-llama-cpp`; see the repository's Security tab for the current list.

## [0.4.0] - 2026-10-08

> **No installers were published with v0.4.0.** Its desktop build failed and the release step published anyway. Use v0.4.2.

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
- **Dependency Audit**: Dependabot alerts went from 102 to 19 at the time of release; the remaining ones are mostly transitive through `electron-builder` and `node-llama-cpp`.

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
