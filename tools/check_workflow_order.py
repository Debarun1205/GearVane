"""Check every workflow builds workspaces in a valid order.

The desktop app imports @gearvane/harness, and TypeScript resolves that
through package exports, so the harness's dist must exist before the desktop
is built or typechecked. Two CI jobs missed that step and failed with
'Cannot find module @gearvane/harness'. A third caught it.

Dependencies are read from the source rather than hardcoded. A hand-written
map goes stale the moment a package adds or drops an import, and a stale map
produces false failures that train people to ignore the checker.
"""

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WORKFLOWS = REPO / ".github" / "workflows"

# Steps that resolve imports, so they need every dependency built.
RESOLVING = re.compile(r"\b(build|typecheck)\b")
BUILD_COMMAND = re.compile(r"--workspace\s+(@?[\w./-]+)")
IMPORT = re.compile(r"""from ['"](@gearvane/[\w-]+)""")


def workspace_dependencies() -> dict[str, set[str]]:
    """Read each workspace's internal imports from its source."""
    dependencies: dict[str, set[str]] = {}

    for prefix in ("packages", "apps"):
        root = REPO / prefix
        if not root.is_dir():
            continue

        for directory in sorted(root.iterdir()):
            manifest = directory / "package.json"
            source = directory / "src"
            if not manifest.is_file() or not source.is_dir():
                continue

            name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
            if not name:
                continue

            found: set[str] = set()
            for path in source.rglob("*.ts"):
                found.update(IMPORT.findall(path.read_text(encoding="utf-8")))

            dependencies[name] = found

    return dependencies


def main() -> int:
    dependencies = workspace_dependencies()

    print("Internal imports, read from source:")
    for name in sorted(dependencies):
        imports = ", ".join(sorted(dependencies[name])) or "none"
        print(f"  {name:22} {imports}")
    print()

    problems: list[str] = []

    for path in sorted(WORKFLOWS.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        jobs = re.split(r"\n  (?=\w[\w-]*:\n)", text)

        for job in jobs:
            name = job.split(":", 1)[0].strip()
            if not RESOLVING.search(job):
                continue

            built = set(BUILD_COMMAND.findall(job))
            if not built:
                continue

            checked = False
            for consumer in sorted(built):
                needed = dependencies.get(consumer, set())
                if not needed:
                    continue

                checked = True
                missing = needed - built
                if missing:
                    problems.append(
                        f"{path.name} / '{name}': builds {consumer} but not "
                        f"{', '.join(sorted(missing))}"
                    )

            if checked:
                print(f"  checked  {path.name} / {name}")

    if problems:
        print()
        for problem in problems:
            print(f"PROBLEM: {problem}")
        print()
        print("A workspace that imports another resolves it through package")
        print("exports, so that workspace's dist must exist first.")
        return 1

    print("\nOK: every build and typecheck step builds its dependencies first")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())