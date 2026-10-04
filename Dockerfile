# GearVane container image.
#
# Build:  docker build -t gearvane .
# Run:    docker run --rm gearvane route --task "Fix a typo"
#
# The package is installed non-editable, so the image contains a real
# installation rather than a link back to the source tree.

FROM python:3.12-slim

# git is needed by the GitHub deployment tooling; curl is used by the
# Ollama health probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so this layer is cached across source-only changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Then the package metadata, so a version bump rebuilds only this layer.
COPY setup.py setup.cfg README.md LICENSE ./
COPY gearvane ./gearvane

RUN pip install --no-cache-dir .

# Run-time artifacts. Declared as a volume so they can be mounted and are
# not baked into the image.
VOLUME ["/app/artifacts"]

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    GEARVANE_ARTIFACTS=/app/artifacts

# Fail the container healthcheck if the CLI is broken.
HEALTHCHECK --interval=60s --timeout=15s --retries=3 \
    CMD gearvane --help > /dev/null || exit 1

ENTRYPOINT ["gearvane"]
CMD ["--help"]