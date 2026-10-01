"""Tests for packaging metadata and build correctness."""

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


class TestProjectMetadata:
    def test_readme_exists(self):
        assert (PROJECT_ROOT / "README.md").is_file()

    def test_license_exists(self):
        assert (PROJECT_ROOT / "LICENSE").is_file()

    def test_license_is_mit(self):
        text = (PROJECT_ROOT / "LICENSE").read_text(encoding="utf-8")
        assert "MIT License" in text

    def test_setup_py_importable(self):
        # setup.py must at least be syntactically valid Python.
        source = (PROJECT_ROOT / "setup.py").read_text(encoding="utf-8")
        compile(source, "setup.py", "exec")

    def test_version_matches_package(self):
        setup = (PROJECT_ROOT / "setup.py").read_text(encoding="utf-8")
        init = (PROJECT_ROOT / "waypoint" / "__init__.py").read_text(encoding="utf-8")
        setup_version = re.search(r'version="([^"]+)"', setup).group(1)
        init_version = re.search(r'__version__ = "([^"]+)"', init).group(1)
        assert setup_version == init_version

    def test_requires_python_supports_matrix(self):
        setup = (PROJECT_ROOT / "setup.py").read_text(encoding="utf-8")
        assert 'python_requires=">=3.9"' in setup


class TestRequirements:
    def test_runtime_requirements_exist(self):
        assert (PROJECT_ROOT / "requirements.txt").is_file()

    def test_dev_requirements_include_runtime(self):
        dev = (PROJECT_ROOT / "requirements-dev.txt").read_text(encoding="utf-8")
        assert "-r requirements.txt" in dev

    def test_dev_requirements_cover_ci_tools(self):
        dev = (PROJECT_ROOT / "requirements-dev.txt").read_text(encoding="utf-8")
        for tool in ("pytest", "flake8", "black", "isort", "mypy"):
            assert tool in dev, f"missing {tool}"

    def test_runtime_requirements_are_minimal(self):
        # The core is stdlib-only, so runtime deps must stay small.
        lines = [
            line.strip()
            for line in (PROJECT_ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        assert len(lines) <= 10


class TestLintConfig:
    def test_flake8_config_present(self):
        config = (PROJECT_ROOT / "setup.cfg").read_text(encoding="utf-8")
        assert "[flake8]" in config

    def test_black_config_present(self):
        config = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        assert "[tool.black]" in config

    def test_mypy_config_present(self):
        config = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        assert "[tool.mypy]" in config

    def test_mypy_python_version_supported(self):
        # mypy dropped 3.9 support; pinning it would fail CI.
        config = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        assert 'python_version = "3.9"' not in config


class TestWorkflows:
    def test_ci_workflow_runs_lint_and_tests(self):
        workflow = (PROJECT_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        for step in ("pytest", "flake8", "black", "isort", "mypy"):
            assert step in workflow, f"CI missing {step}"

    def test_ci_covers_python_matrix(self):
        workflow = (PROJECT_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        for version in ("3.9", "3.10", "3.11", "3.12"):
            assert version in workflow, f"CI missing Python {version}"

    def test_ci_has_cli_smoke_job(self):
        workflow = (PROJECT_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        assert "cli-smoke" in workflow


class TestDocker:
    def test_dockerfile_present(self):
        assert (PROJECT_ROOT / "Dockerfile").is_file()

    def test_compose_present(self):
        assert (PROJECT_ROOT / "docker-compose.yml").is_file()

    def test_dockerfile_installs_requirements(self):
        dockerfile = (PROJECT_ROOT / "Dockerfile").read_text(encoding="utf-8")
        assert "requirements.txt" in dockerfile
        assert "pip install" in dockerfile


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """Build the distribution once and share it across the tests below."""
    if not _has_module("build"):
        pytest.skip("python -m build is not installed")

    outdir = tmp_path_factory.mktemp("dist")
    result = subprocess.run(
        [sys.executable, "-m", "build", "--outdir", str(outdir)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        pytest.fail(f"build failed:\n{result.stdout}\n{result.stderr}")
    return outdir


class TestBuildArtifacts:
    """The distribution must build and the installed console script work."""

    def test_wheel_is_produced(self, built):
        wheels = list(built.glob("*.whl"))
        assert wheels, "no wheel produced"

    def test_sdist_is_produced(self, built):
        tarballs = list(built.glob("*.tar.gz"))
        assert tarballs, "no sdist produced"

    def test_wheel_excludes_tests(self, built):
        import zipfile

        wheel = next(built.glob("*.whl"))
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
        assert not any(n.startswith("tests/") for n in names), "tests must not ship in the wheel"

    def test_wheel_contains_package(self, built):
        import zipfile

        wheel = next(built.glob("*.whl"))
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
        assert "waypoint/__init__.py" in names
        assert "waypoint/cli.py" in names
        assert "waypoint/providers.py" in names

    def test_wheel_declares_console_script(self, built):
        import zipfile

        wheel = next(built.glob("*.whl"))
        with zipfile.ZipFile(wheel) as archive:
            entry_points = next(n for n in archive.namelist() if n.endswith("entry_points.txt"))
            content = archive.read(entry_points).decode()
        assert "waypoint = waypoint.cli:main" in content

    def test_wheel_ships_license(self, built):
        import zipfile

        wheel = next(built.glob("*.whl"))
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
        assert any("LICENSE" in n for n in names)

    def test_build_emits_no_license_classifier_warning(self, built):
        # Deprecated trove classifiers produce a build warning.
        setup = (PROJECT_ROOT / "setup.py").read_text(encoding="utf-8")
        assert "License :: OSI Approved" not in setup


class TestSourceIsAscii:
    """Non-ASCII in source breaks Windows consoles using cp1252."""

    @pytest.mark.parametrize(
        "path",
        sorted(
            list((PROJECT_ROOT / "waypoint").glob("*.py"))
            + list((PROJECT_ROOT / "tests").glob("*.py"))
        ),
        ids=lambda p: p.name,
    )
    def test_file_is_ascii(self, path):
        text = path.read_text(encoding="utf-8")
        offenders = {c for c in text if ord(c) > 127}
        assert not offenders, f"{path.name} has non-ascii: {offenders}"
