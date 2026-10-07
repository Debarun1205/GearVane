# Building the installers

This directory holds the build configuration. Building the actual binaries
needs platform toolchains that are not part of the repository.

## What is already built

The Electron main process and the renderer bundle are produced by
`npm run build` and verified by CI. The renderer bundles to a single
self-contained file, so the same JavaScript runs in the desktop window and
inside the Android webview.

What is **not** in the repository, and why:

| Artifact | Needs |
|----------|-------|
| Windows `.exe` (NSIS) | Runs on Windows with network access to download electron-builder's winCodeSign and nsis tooling |
| Linux `AppImage` / `.deb` | Runs on Linux; cross-building AppImage from Windows is not supported by electron-builder |
| macOS `.dmg` | Must run on macOS; Apple does not permit building macOS installers elsewhere |
| Android `.apk` | Android SDK, a JDK, and the Gradle wrapper in `android/` |

## Bundled local model

The installer carries **two** weights: SmolLM2 360M (~258 MB) and
Qwen2.5-Coder 0.5B (~409 MB), both flagged `bundled` in `src/models.json`. That
is enough for the `local` tier to answer offline the moment the app opens, for
0.65 GiB together.

Nothing else is bundled, and the other 48 weights do not all arrive on first
launch either. Two are flagged `first-boot` (Qwen2.5 7B and Qwen3 8B, 9.04 GiB)
and the app fetches those in the background on a first launch. The remaining 46
download when you pick them. The GGUF is **not** committed to git:

```bash
cd apps/desktop
npm run models:fetch   # downloads into resources/models/ (gitignored)
npm run dist:win       # or dist:linux / dist
```

The `dist` scripts run `models:fetch` themselves, so a local build matches a
CI build. `extraResources` names that single GGUF rather than the
`resources/models` directory, which matters: the directory is gitignored, so
naming it meant a build copied whatever weights the machine happened to have
— several GiB of them, past the 2 GiB per-asset limit GitHub enforces on
release uploads. Naming the file makes that impossible.

The weight lands beside the app under `resources/models`, where the main
process serves it on loopback. Without it the embedded tier reports
unavailable and the other local providers carry on — the app never downloads a
model on its own. Point `GEARVANE_MODEL_DIR` elsewhere, or
`GEARVANE_EMBEDDED_MODEL` at a different GGUF name, to run another model.
The release workflow fetches automatically on tag builds.

## Model catalog

`src/models.json` is the single source for every model the app knows:
the fetch script, the Models dialog, and the installer payload all read
it, so they cannot drift apart. Two entries are flagged `bundled` and
ship in the installer; the rest download on demand from the dialog.
Sizes are pinned by `test/models-catalog.test.ts` — a re-quantized
upstream file fails loudly instead of silently changing the installer.

## Windows

```bash
npm run dist:win
```

Output lands in `release/`. Produces an NSIS installer and a portable
executable for x64.

**Symlink privilege:** electron-builder extracts its `winCodeSign` helper
with symbolic links, which Windows refuses without Developer Mode or an
elevated shell. If packaging fails with `Cannot create symbolic link`, enable
Developer Mode in *Settings → System → For developers*, or run the build from
an elevated shell. CI runners are unaffected.

## Linux

```bash
npm run dist:linux
```

Output lands in `release/` as an `AppImage` and a `.deb`, for x64 and arm64.
Build this on Linux; electron-builder cannot produce a Linux AppImage from
Windows or macOS.

## macOS

```bash
npm run dist
```

Runs on macOS and produces a universal `.dmg`. Unsigned builds are blocked
by Gatekeeper, so a distribution build needs an Apple Developer certificate
configured in `electron-builder`.

## Android

The Android project is generated once and committed under `android/`, then
synced whenever the renderer changes.

```bash
# One-time: create the native Android project
npx cap add android

# After every renderer change
npm run android:sync

# Build a debug APK
npm run android:apk
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

A release APK needs a keystore:

```bash
keytool -genkey -v -keystore gearvane.keystore -alias gearvane \
  -keyalg RSA -keysize 2048 -validity 10000

# then set in ~/.gradle/gradle.properties
GEARVANE_STORE_FILE=gearvane.keystore
GEARVANE_STORE_PASSWORD=...
GEARVANE_KEY_ALIAS=gearvane
GEARVANE_KEY_PASSWORD=...
```

Never commit a keystore or a signing password.

## Release automation

`.github/workflows/release.yml` builds all three desktop targets on their
own runners and assembles the APK on Linux. It triggers on a `v*.*.*` tag:

```bash
git tag v0.3.0        # the version being released, X.Y.Z bumped everywhere
git push origin v0.3.0
```

## Verifying a build without running it

```bash
# Confirm the renderer is self-contained
npm run build:renderer
grep -c "^import" renderer/renderer.js   # expect 0

# Confirm the installer was produced
ls release/
```