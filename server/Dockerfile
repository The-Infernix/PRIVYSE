# PRIVYSE agent server — lightweight FastAPI + uvicorn image.
#
#   docker build -t privyse-server ./server
#   docker run --rm -p 8000:8000 \
#     -e OPENAI_BASE_URL=http://host.docker.internal:11434/v1 \
#     -e VLM_MODEL=qwen2.5vl:3b \
#     privyse-server
#
# The VLM itself is NOT baked in — point OPENAI_BASE_URL at Ollama (see
# docker-compose.yml) or any OpenAI-compatible endpoint.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Bind 0.0.0.0 so the port is reachable from outside the container.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
