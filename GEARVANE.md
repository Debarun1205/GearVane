# GearVane Workspace Instructions

This file contains custom guidelines and architectural context automatically
injected into GearVane's agent system prompt when working in this workspace.

## Project Guidelines

- **Architecture**: Monorepo managed with npm workspaces across `@gearvane/core`, `@gearvane/harness`, `@gearvane/cli`, `@gearvane/app-core`, and `apps/desktop`.
- **Code Style**: Strict TypeScript, ESLint formatting, and minimal external dependencies.
- **Testing**: Vitest for unit and integration testing. Keep tests deterministic and fast.
- **Safety**: Pure local model support, sandbox containment, and zero gated capabilities.
