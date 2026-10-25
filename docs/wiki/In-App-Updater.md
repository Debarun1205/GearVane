# In-App Updater

GearVane features an in-app updater designed to keep desktop installations up-to-date without requiring users to navigate to GitHub releases.

---

## Design & Implementation

To prevent symlink and permission issues on Windows CI, GearVane implements a lightweight native update engine rather than heavy external updater daemons:

```
[GitHub Releases API] 
       │ (JSON via HTTPS)
       ▼
[Main Process: updater-host.ts] ──(IPC: updater:available)──> [Renderer: mountUpdateBanner]
       │                                                                  │
       │ (Download stream with progress)                                   │ Click "Update Now"
       ▼                                                                  ▼
[Temp Directory / Update Cache] <──(IPC: updater:download)────────────────┘
       │
       ▼
[shell.openPath / Installer Spawn]
```

### Key Modules
1. **`apps/desktop/src/updater.ts`**:
   - `fetchLatestRelease(repo)`: Queries `https://api.github.com/repos/Debarun1205/GearVane/releases/latest`.
   - `parseSemver(version)`: Parses standard semantic versioning (`major.minor.patch`).
   - `isNewerVersion(current, latest)`: Compares the running app version with the latest release tag.
   - `findPlatformAsset(assets, platform)`: Maps the host operating system (`win32`, `darwin`, `linux`) to the corresponding installer asset (e.g. `GearVane-Setup-*.exe`, `.dmg`, `.AppImage`).
   - `downloadUpdateFile(url, destination, onProgress)`: Streams the installer with download percentage callbacks.

2. **`apps/desktop/src/updater-host.ts`**:
   - Background Polling: Checks for updates 5 seconds after launch, and periodically every 4 hours.
   - IPC Handlers:
     - `updater:check`: Triggers an immediate release check.
     - `updater:download`: Downloads the installer binary to the temporary update cache and launches it via `shell.openPath()`.
     - `updater:open-url`: Opens GitHub release notes in the system browser.

3. **`apps/desktop/src/renderer.ts`**:
   - `mountUpdateBanner(bridge)`: Displays an interactive banner when an update is detected.
   - Shows release version, notes summary, live download progress bar, and "Update Now" action.
