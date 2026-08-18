FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install --no-install-recommends --yes postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system artflow \
    && useradd --system --create-home --gid artflow --shell /usr/sbin/nologin artflow

WORKDIR /app

RUN python -m pip install --no-cache-dir "uv==0.11.29"

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --extra production

COPY --chown=artflow:artflow manage.py ./
COPY --chown=artflow:artflow accounts ./accounts
COPY --chown=artflow:artflow archive ./archive
COPY --chown=artflow:artflow common ./common
COPY --chown=artflow:artflow config ./config
COPY --chown=artflow:artflow core ./core
COPY --chown=artflow:artflow exports ./exports
COPY --chown=artflow:artflow farewell_show ./farewell_show
COPY --chown=artflow:artflow files ./files
COPY --chown=artflow:artflow incidents ./incidents
COPY --chown=artflow:artflow public_portal ./public_portal
COPY --chown=artflow:artflow singer_contest ./singer_contest
COPY --chown=artflow:artflow staff_panel ./staff_panel
COPY --chown=artflow:artflow voting ./voting
COPY --chown=artflow:artflow static ./static
COPY --chown=artflow:artflow templates ./templates
COPY --chown=artflow:artflow scripts/docker-entrypoint.sh scripts/wait-for-postgres.sh ./scripts/

RUN mkdir --parents /app/media /app/staticfiles \
    && chmod 0755 /app/scripts/docker-entrypoint.sh /app/scripts/wait-for-postgres.sh \
    && chown --recursive artflow:artflow /app/media /app/staticfiles /app/scripts

USER artflow

EXPOSE 8000

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3", "--access-logfile", "-", "--error-logfile", "-"]
