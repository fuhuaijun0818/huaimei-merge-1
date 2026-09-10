ARG PYTHON_IMAGE=python:3.12.11-slim-bookworm
FROM ${PYTHON_IMAGE}

ARG HUAMEI_BUILD_REVISION=unknown
ARG HUAMEI_BUILD_CREATED=unknown

LABEL org.opencontainers.image.title="Huamei LangGraph Agent Orchestrator" \
      org.opencontainers.image.revision="${HUAMEI_BUILD_REVISION}" \
      org.opencontainers.image.created="${HUAMEI_BUILD_CREATED}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml ./
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock \
  && useradd --create-home --uid 10001 appuser

COPY app ./app
RUN pip install --no-cache-dir --no-deps . \
  && pip check

USER appuser
EXPOSE 4192

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "from urllib.request import urlopen; assert urlopen('http://127.0.0.1:4192/health').status == 200"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4192"]
