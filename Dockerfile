FROM python:3.11-slim

WORKDIR /app

# Set Python environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# Default timezone (overridable in docker-compose.yml)
ENV TZ=Asia/Kolkata

# tzdata is required for the TZ env var to resolve to real local time
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

# Copy backend requirements and install dependencies
COPY backend/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy source folders
COPY backend/ /app/backend/
COPY frontend/ /app/frontend/

# Persistent data directory: the SQLite DB and the AES vault key live here.
# A volume is mounted over this path in docker-compose.yml.
RUN mkdir -p /app/data

# Expose server port
EXPOSE 8000

# Set command to boot the server
CMD ["python", "-m", "backend.main"]
