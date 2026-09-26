FROM node:22-bookworm-slim

WORKDIR /app

# Install Python & pytest for verification pipeline
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-pytest \
    make \
    && rm -rf /var/lib/apt/lists/*

# Copy project files
COPY . /app

# Default command runs the complete verification suite
CMD ["npm", "test"]
