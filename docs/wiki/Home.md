# GearVane Wiki

Welcome to the **GearVane** official documentation wiki.

GearVane is an intelligent multi-tier AI routing harness, IDE, desktop workspace, and CLI designed to route every developer task to the cheapest, most capable model tier available—seamlessly blending local offline SLMs with mid-tier models and frontier cloud LLMs.

---

## Quick Navigation

| Document | Description |
| :--- | :--- |
| **[Architecture](Architecture)** | Monorepo structure, process boundaries, security containment, and IPC |
| **[Model Tiers & Catalog](Model-Tiers-and-Catalog)** | Complete catalog of 50 models, 3-tier hierarchy, embedded weights, and licensing |
| **[Getting Started & Installation](Getting-Started-and-Installation)** | Downloads and installation guides for Windows, macOS, Linux, Android, and VS Code |
| **[In-App Updater](In-App-Updater)** | How the integrated update notification and direct installer delivery works |
| **[CLI & Harness Guide](CLI-and-Harness)** | Terminal commands, Python reference harness, and configuration reference |
| **[Building from Source](Building-from-Source)** | Prerequisites, workspace compilation, packaging, and local setup |
| **[Contributing & CI Pipeline](Contributing-and-CI)** | Repository testing contracts, multi-platform CI, and development guidelines |

---

## Key Highlights

- **50 Unique Models Categorized by Tiers**:
  - **Local Tier (19 Models)**: Free, privacy-preserving, zero-latency models running on local hardware via embedded llama.cpp runtime, Ollama, or LM Studio.
  - **Mid Tier (14 Models)**: High-efficiency coding and reasoning engines (7B–14B) for routine development tasks.
  - **Frontier Tier (17 Models)**: Top-tier reasoning engines (Claude 3.7/Sonnet, GPT-4o/o3, DeepSeek R1, Gemini 2.5) for complex refactors and architecture.
- **2 Pre-installed Embedded Models**: Ships out-of-the-box with `SmolLM2-360M-Instruct` and `Qwen2.5-Coder-0.5B-Instruct` embedded inside the installer (payload < 1 GiB), ready to infer immediately on launch without any internet connection.
- **In-App Updater**: Automatically checks GitHub releases in the background, surfaces an in-app banner with release notes, and downloads/runs installers in-place.
- **Strict 500 MiB Confirmation Rule**: Any model download 500 MiB or larger mandates explicit user confirmation before initiating, protecting mobile and metered connections.
- **Zero Cost Gating**: Local models never require API keys or metering; default configurations ship with no spend caps or artificial limits.
- **Cross-Platform Matrix**: First-class support for Windows (Installer + Portable), macOS (Apple Silicon DMG), Linux (AppImage + DEB), Android (APK), and VS Code Extension (VSIX).
