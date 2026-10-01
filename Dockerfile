FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Install the package
RUN pip install -e .

# Create volume for logs and feedback
VOLUME ["/app/logs", "/app/feedback"]

# Default command
ENTRYPOINT ["waypoint"]
CMD ["--help"]
