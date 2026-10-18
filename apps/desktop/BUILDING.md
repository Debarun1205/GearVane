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
CI build. `extraResources` names each bundled GGUF rather than the
`resources/models` directory, which matters: the directory is gitignored, so
naming it meant a build copied whatever weights the machine happened to have
— several GiB of them, past the 2 GiB per-asset limit GitHub enforces on
release uploads. Naming the files makes that impossible.

Each entry also gives its **full destination path** (`models/<file>`), never
the bare directory `models`. For a single-file source, electron-builder treats
`to` as a directory only if it already exists, so `to: "models"` wrote the
first weight as a file called `models` and the second overwrote it. The
installer then held one file where the app expects a directory.
`tools/verify-packaged.mjs` checks the result after packaging.

Where weights live in an installed app:

- **Shipped weights** (the two small ones) sit in `resources/models`, inside
  the install. That location is read-only for an AppImage, a `.deb`, and a
  per-machine Windows install, so nothing is ever written there.
- **Downloaded weights** (first-boot and one-click installs) go to
  `<userData>/models` (for example `%APPDATA%\GearVane\models`). The embedded
  server serves both directories; the picker counts both as installed.
- Installed builds fetch the two first-boot weights in the background on a
  first launch. An unpackaged run (`npm start`, the Playwright tests) does not;
  set `GEARVANE_PROVISION=1` to try the chip by hand, or `GEARVANE_PROVISION=0`
  to stop a packaged build downloading (the packaged smoke test does).
- In development the single directory is `resources/models`, where
  `npm run models:fetch` puts weights.

Without a weight the embedded tier reports unavailable and the other local
providers carry on. Point `GEARVANE_MODEL_DIR` elsewhere (it replaces both
directories), or `GEARVANE_EMBEDDED_MODEL` at a different GGUF name, to run
another model. The release workflow fetches the bundled weights automatically
on tag builds.

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

Output lands in `release/` as an `AppImage` and a `.deb`, for x64. Build this
on Linux; electron-builder cannot produce a Linux AppImage from Windows or
macOS.

arm64 is not built. The embedded model runtime and the terminal are native
modules, and `npm ci` installs them for the machine it runs on, so an arm64
package built on an x64 runner would have no working local model. Add it with a
native arm64 runner.

## macOS

```bash
npm run dist
```

Runs on macOS and produces an Apple Silicon (arm64) `.dmg`. Intel Macs are not
built, for the same native-module reason as Linux arm64; add them with an Intel
runner. Unsigned builds are blocked
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
own runners and assembles the APK on Linux. It triggers on a `v*.*.*` tag.

To release:

```bash
node tools/versions.mjs set 0.4.3      # every version string, in one command
# add a "## [0.4.3] - YYYY-MM-DD" section to CHANGELOG.md; it becomes the notes
git commit -am "chore(release): 0.4.3"
git tag -a v0.4.3 -m "GearVane 0.4.3"
git push origin master v0.4.3
```

The pipeline then, in order:

1. **preflight**: the tag equals every version string, the changelog has a
   section for it, and `tools/verify-requirements.mjs` passes.
2. **desktop** (per platform): build, fetch the bundled weights, package, check
   the installers exist and are named for the version, run
   `tools/verify-packaged.mjs` on the unpacked output, run the packaged smoke
   test, upload.
3. **publish**: requires the desktop and VS Code jobs to have succeeded. It
   writes `SHA256SUMS.txt`, creates a **draft** release with the changelog
   section as its notes, checks that every file uploaded, and only then
   publishes. A failed run leaves a draft nobody can see.

Run the workflow from the Actions tab (`workflow_dispatch`) on a branch to build
and download every installer without tagging or publishing anything. Do that
before tagging.

## Verifying a build without running it

```bash
# Confirm the renderer is self-contained
npm run build:renderer
grep -c "^import" renderer/renderer.js   # expect 0

# Confirm the installer was produced
ls release/
```