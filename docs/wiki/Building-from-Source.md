# Building from Source

This guide covers building the GearVane monorepo, including the TypeScript packages, Electron desktop application, VS Code extension, and Python reference harness.

---

## Prerequisites

- **Node.js**: Version 20.x or 22.x LTS
- **npm**: Version 10+ or 11+
- **Python**: Version 3.10, 3.11, or 3.12 (Python 3.9 is also supported via compatibility markers)
- **Git**: Recent Git release with LFS support
- **Platform Build Tools**:
  - *Windows*: Visual Studio Build Tools with C++ workload (for `node-gyp` native bindings).
  - *macOS*: Xcode Command Line Tools (`xcode-select --install`).
  - *Linux*: `build-essential`, `libsecret-1-dev`, `python3-dev`.

---

## Workspace Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Debarun1205/GearVane.git
   cd GearVane
   ```

2. **Install all dependencies**:
   ```bash
   npm ci
   ```

3. **Install Python development dependencies**:
   ```bash
   pip install -r requirements-dev.txt
   pip install -e .
   ```

---

## Building Packages

The monorepo enforces dependency build ordering (core -> harness -> app-core -> cli -> apps):

```bash
# Build all workspaces
npm run build

# Or build individual packages
npm run build --workspace @gearvane/core
npm run build --workspace @gearvane/harness
npm run build --workspace @gearvane/app-core
npm run build --workspace @gearvane/cli
npm run build --workspace gearvane-app
npm run build --workspace gearvane
```

---

## Running Tests

GearVane incorporates comprehensive unit, contract, and repository test suites:

```bash
# Run all TypeScript workspace tests
npm test

# Run repository contract and requirements tests
npm run test:repo

# Run Python reference harness tests
pytest tests/ -v

# Run the complete test suite across all engines
npm run test:all
```

---

## Packaging Desktop Installers

To package Electron binaries:

```bash
# Package for current host platform
npm run package --workspace gearvane-app

# Windows installers
npm run dist:win --workspace gearvane-app

# macOS DMG
npm run dist:mac --workspace gearvane-app

# Linux AppImage & DEB
npm run dist:linux --workspace gearvane-app
```
*Note: Packaged desktop builds automatically incorporate `asar: false` and bundle the two low-tier embedded GGUF weights into `models/bundled/`.*
