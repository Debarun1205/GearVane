# Contributing & CI Pipeline

This guide outlines our development practices, testing requirements, security auditing, and continuous integration pipeline.

---

## Continuous Integration Pipeline

Every push and pull request against `master` triggers the comprehensive GitHub Actions CI matrix:

| Job | Environment | Description |
| :--- | :--- | :--- |
| **`python`** | Matrix: 3.9 (Ubuntu 22.04), 3.10, 3.11, 3.12 | Verifies reference Python router, tests, and coverage |
| **`javascript`** | Ubuntu Latest (Node 20) | Compiles all TypeScript packages in dependency order |
| **`javascript-tests`**| Ubuntu Latest (Node 20) | Runs workspace Vitest suites, requirement checks, catalog pins |
| **`portability`** | macOS Latest, Windows Latest | Tests platform-specific native hardware measurements and keychains |
| **`e2e`** | Ubuntu Latest, macOS Latest, Windows Latest | Full Playwright and packaged binary execution |
| **`lint` / `python-lint`**| Ubuntu Latest | Enforces ESLint, Prettier, Flake8, Black, Isort, and Mypy |
| **`gitleaks`** | Ubuntu Latest | Scans commit history for secrets and API keys |
| **`CodeQL`** | GitHub CodeQL Engine | Deep static analysis for security vulnerabilities |

---

## Repository Testing Contracts

In addition to standard unit tests, GearVane gates builds on explicit architectural contracts:

1. **Requirement Verification (`tools/verify-requirements.mjs`)**:
   - Asserts exactly 50 models in catalog.
   - Confirms all 50 entries have download URLs, sizes, commit SHAs, and SHA256 checksums.
   - Verifies exactly 4 embedded models (2 low, 1 mid, 1 high) with Apache-2.0 licenses.
   - Asserts the 500 MiB threshold constant is uniform across main process and UI.
   - Enforces installer payload budget < 1 GiB.
2. **Catalog Revision Pinning (`tools/check-catalog-pins.mjs`)**:
   - Ensures no weight points to mutable `main` branches; all weights must pin 40-character commit SHAs.
3. **Synchronized Tables & Notices**:
   - `tools/gen-site-catalog.mjs --check`: Verifies the landing site matches `models.json`.
   - `tools/gen-readme-tables.mjs --check`: Verifies README tier tables match `models.json`.
   - `tools/gen-third-party-notices.mjs --check`: Ensures `THIRD_PARTY_NOTICES.md` reflects all licenses.

---

## Security & Dependabot Audits

- Dependencies are monitored via Dependabot with monthly automated updates.
- Root `package.json` overrides resolve transitive security advisories.
- All high or critical security alerts from `npm audit` or Dependabot must be resolved before releases are published.
