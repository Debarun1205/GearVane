from pathlib import Path

from setuptools import find_packages, setup

ROOT = Path(__file__).parent
README = (ROOT / "README.md").read_text(encoding="utf-8")

setup(
    name="waypoint",
    version="0.1.0",
    description="Open-source AI harness with intelligent task routing",
    long_description=README,
    long_description_content_type="text/markdown",
    author="Debarun",
    license="MIT",
    packages=find_packages(exclude=("tests", "tests.*")),
    python_requires=">=3.9",
    install_requires=[
        # The core is stdlib-only; these are for config parsing and console
        # output. Providers use urllib, so no HTTP client is required.
        "pyyaml>=6.0",
        "click>=8.0",
        "rich>=13.0",
        "pydantic>=2.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0",
            "pytest-cov>=4.0",
            "flake8>=6.0",
            "black>=23.0",
            "isort>=5.12",
            "mypy>=1.5",
            "build>=1.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "waypoint=waypoint.cli:main",
        ],
    },
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Build Tools",
    ],
    keywords="llm, routing, model-selection, ai-harness, opencode",
)