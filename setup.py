from setuptools import setup, find_packages

setup(
    name="waypoint",
    version="0.1.0",
    description="Open-source AI harness with intelligent task routing",
    author="Debarun",
    packages=find_packages(),
    install_requires=[
        "pyyaml>=6.0",
        "click>=8.0",
        "rich>=13.0",
        "pydantic>=2.0",
    ],
    entry_points={
        "console_scripts": [
            "waypoint=waypoint.cli:main",
        ],
    },
    python_requires=">=3.9",
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
)
