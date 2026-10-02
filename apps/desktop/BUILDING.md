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

## Windows

```bash
npm run dist:win
```

Output lands in `release/`. Produces an NSIS installer and a portable
executable for x64.

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
keytool -genkey -v -keystore waypoint.keystore -alias waypoint \
  -keyalg RSA -keysize 2048 -validity 10000

# then set in ~/.gradle/gradle.properties
WAYPOINT_STORE_FILE=waypoint.keystore
WAYPOINT_STORE_PASSWORD=...
WAYPOINT_KEY_ALIAS=waypoint
WAYPOINT_KEY_PASSWORD=...
```

Never commit a keystore or a signing password.

## Release automation

`.github/workflows/release.yml` builds all three desktop targets on their
own runners and assembles the APK on Linux. It triggers on a `v*.*.*` tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## Verifying a build without running it

```bash
# Confirm the renderer is self-contained
npm run build:renderer
grep -c "^import" renderer/renderer.js   # expect 0

# Confirm the installer was produced
ls release/
```