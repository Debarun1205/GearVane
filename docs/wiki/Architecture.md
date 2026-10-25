# Architecture Overview

GearVane is architected as a modular TypeScript/Python monorepo. It enforces strict separation between privileged host environments (node/system capabilities, filesystems, native llama.cpp execution) and untrusted or sandboxed environments (Electron renderers, Android WebViews, VS Code webviews).

---

## Workspace Layout

```
GearVane/
├── apps/
│   ├── desktop/            # Electron desktop application (Main process + UI Renderer)
│   ├── app-core/           # Framework-agnostic client logic shared by Desktop & Android
│   ├── vscode-extension/   # VS Code extension integration
│   └── android/            # Capacitor-wrapped Android APK
├── packages/
│   ├── core/               # Core routing engine, model classifiers, spend tracking, retry logic
│   ├── harness/            # Tool execution sandbox, workspace containment, taint tracker, builder
│   └── cli/                # Terminal CLI (commands, verifiers, feedback loops)
├── python/
│   └── gearvane/           # Pure-Python reference harness, pytest test suite, and packaging
├── site/                   # Public landing site hosted via GitHub Pages
└── tools/                  # CI verification scripts, catalog generators, notice builders
```

---

## Process & Security Boundaries

### 1. Main Process vs Renderer Isolation
The Electron desktop application (`apps/desktop`) isolates Node.js and OS capabilities inside the main process:
- `apps/desktop/src/main.ts`: Electron lifecycle, window creation, provisioning, and host registry.
- `apps/desktop/src/preload.cjs`: Secure `contextBridge` exposing only explicit IPC methods on `window.gearvane`.
- `apps/desktop/src/renderer.ts`: Frontend renderer bundle. It runs with zero Node.js privileges, making it directly portable to Android's WebView.

### 2. Workspace Containment & Taint Tracking
Security containment is enforced within `@gearvane/harness`:
- **Workspace Containment**: File read/write tools are strictly confined to the project workspace directory; path traversal attacks (`../`) are intercepted and rejected.
- **Taint Tracking**: Tracks data originating from untrusted web searches or external tools, ensuring that tainted data cannot invoke dangerous local execution tools without explicit human authorization.
- **Approval Gating**: Shell commands and high-risk system calls require interactive user approval.

---

## Native Model Execution & llama.cpp Integration

GearVane executes local models using embedded llama.cpp runtime bindings (`node-llama-cpp`):
1. **Model Storage**: Bundled models are unpacked into the application user data directory (`models/bundled/`).
2. **Local HTTP Server**: An embedded HTTP server (`apps/desktop/src/embedded-server.ts`) exposes an OpenAI-compatible API on `127.0.0.1`.
3. **Hardware Acceleration**: Automatic fallback across Vulkan, Metal, CUDA, and CPU execution depending on host architecture.

---

## 500 MiB Download Safeguard

To ensure users never unintentionally consume heavy bandwidth:
- Defined centrally as `MAX_AUTO_DOWNLOAD_BYTES = 524_288_000` (500 MiB).
- Any model weight download at or above this threshold triggers an interactive confirmation modal detailing:
  - Exact file size in GiB
  - Remote repository revision SHA
  - SHA256 integrity hash
- Only user confirmation proceeds with the network stream.
