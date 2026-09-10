ARG PYTHON_IMAGE=python:3.12.11-slim-bookworm
FROM ${PYTHON_IMAGE}

ARG HUAMEI_BUILD_REVISION=unknown
ARG HUAMEI_BUILD_CREATED=unknown

LABEL org.opencontainers.image.title="Huamei GraphRAG Retrieval" \
      org.opencontainers.image.revision="${HUAMEI_BUILD_REVISION}" \
      org.opencontainers.image.created="${HUAMEI_BUILD_CREATED}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HUAMEI_ENVIRONMENT=production \
    HUAMEI_GRAPHRAG_HOST=0.0.0.0 \
    HUAMEI_GRAPHRAG_PORT=4191 \
    HUAMEI_GRAPHRAG_ENGINE=official \
    HUAMEI_GRAPHRAG_MAX_CONCURRENCY=128 \
    LITELLM_LOCAL_MODEL_COST_MAP=True

WORKDIR /service

COPY graphrag-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 graphrag

COPY --chown=graphrag:graphrag graphrag-service/app ./app
COPY --chown=graphrag:graphrag graphrag-service/data ./data
COPY --chown=graphrag:graphrag graphrag-service/graphrag_project/settings.yaml ./graphrag_project/settings.yaml
COPY --chown=graphrag:graphrag graphrag-service/graphrag_project/prompts ./graphrag_project/prompts

USER graphrag

EXPOSE 4191

HEALTHCHECK --interval=20s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4191/ready', timeout=2)"]

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4191", "--workers", "4", "--no-access-log", "--limit-concurrency", "600"]
