"""Check that every TypeScript workspace can be built from clean, in order.

The desktop build failed in CI because it imports @waypoint/harness and the
harness had not been built. This reproduces a clean checkout so the ordering
dependency is checked locally rather than discovered on a runner.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
NPM = r"C:\Program Files\nodejs\npm.cmd"

ORDER = [
    "@waypoint/core",
    "@waypoint/harness",
    "waypoint-app",
    "waypoint",
]


def clean(workspace_dir: Path) -> None:
    shutil.rmtree(workspace_dir / "dist", ignore_errors=True)
    for info in workspace_dir.glob("*.tsbuildinfo"):
        info.unlink(missing_ok=True)


def workspace_dir(name: str) -> Path:
    manifest = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
    del manifest  # workspaces are discovered by scanning instead

    for prefix in ("packages", "apps"):
        root = REPO / prefix
        if not root.is_dir():
            continue
        for candidate in root.iterdir():
            package_file = candidate / "package.json"
            if not package_file.is_file():
                continue
            data = json.loads(package_file.read_text(encoding="utf-8"))
            if data.get("name") == name:
                return candidate

    raise SystemExit(f"workspace not found: {name}")


def main() -> int:
    print("Cleaning build output, then building in dependency order.\n")

    for name in ORDER:
        clean(workspace_dir(name))
        print(f"  cleaned  {name}")

    print()

    for name in ORDER:
        result = subprocess.run(
            [NPM, "run", "build", "--workspace", name],
            cwd=REPO,
            capture_output=True,
            text=True,
        )
        output = result.stdout + result.stderr

        if result.returncode != 0:
            print(f"  FAILED   {name}")
            for line in output.splitlines():
                if "error TS" in line or "npm error" in line:
                    print(f"           {line.strip()}")
            return 1

        directory = workspace_dir(name) / "dist"

        # An app has no index; it has main.js and renderer.js. What matters is
        # that the build emitted something loadable rather than exiting zero
        # with an empty output directory.
        if not directory.is_dir():
            print(f"  INCOMPLETE {name}: dist/ was not created")
            return 1

        emitted = [
            path
            for path in directory.rglob("*.js")
            if path.is_file() and path.stat().st_size > 0
        ]

        if not emitted:
            print(f"  INCOMPLETE {name}: no JavaScript emitted")
            return 1

        total = sum(path.stat().st_size for path in emitted)
        print(f"  built    {name}  ({len(emitted)} files, {total} bytes)")

    print("\nOK: every workspace builds from clean in dependency order")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())