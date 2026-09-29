ARG ARTFLOW_PYTHON_IMAGE=python:3.12-slim

FROM ${ARTFLOW_PYTHON_IMAGE}

ARG ARTFLOW_BUILD_SHA=""

LABEL org.opencontainers.image.revision="${ARTFLOW_BUILD_SHA}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl gnupg \
    && install --directory --mode=0755 /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error --location https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor --output /usr/share/keyrings/postgresql.gpg \
    && . /etc/os-release \
    && printf 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$VERSION_CODENAME" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install --no-install-recommends --yes postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system artflow \
    && useradd --system --create-home --gid artflow --shell /usr/sbin/nologin artflow

WORKDIR /app

RUN printf '%s\n' "${ARTFLOW_BUILD_SHA}" > /app/ARTFLOW_RELEASE_SHA

RUN python -m pip install --no-cache-dir "uv==0.11.29"

# Keep the project environment visible to the login shells used by the local
# PostgreSQL acceptance harness and by CI's container smoke checks.
RUN printf '%s\n' 'export PATH="/opt/venv/bin:${PATH}"' >> /etc/profile

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --extra production

COPY --chown=artflow:artflow manage.py ./
COPY --chown=artflow:artflow accounts ./accounts
COPY --chown=artflow:artflow archive ./archive
COPY --chown=artflow:artflow common ./common
COPY --chown=artflow:artflow config ./config
COPY --chown=artflow:artflow core ./core
COPY --chown=artflow:artflow entry_access ./entry_access
COPY --chown=artflow:artflow exports ./exports
COPY --chown=artflow:artflow farewell_show ./farewell_show
COPY --chown=artflow:artflow files ./files
COPY --chown=artflow:artflow incidents ./incidents
COPY --chown=artflow:artflow public_portal ./public_portal
COPY --chown=artflow:artflow questionnaire ./questionnaire
COPY --chown=artflow:artflow ruleset ./ruleset
COPY --chown=artflow:artflow singer_contest ./singer_contest
COPY --chown=artflow:artflow staff_panel ./staff_panel
COPY --chown=artflow:artflow tickets ./tickets
COPY --chown=artflow:artflow voting ./voting
COPY --chown=artflow:artflow static ./static
COPY --chown=artflow:artflow templates ./templates
COPY --chown=artflow:artflow \
    scripts/docker-entrypoint.sh \
    scripts/wait-for-postgres.sh \
    scripts/verify_private_test_package.py \
    ./scripts/

RUN mkdir --parents /app/media /app/staticfiles /app/backups \
    && chmod 0755 /app/scripts/docker-entrypoint.sh /app/scripts/wait-for-postgres.sh \
    && chown --recursive artflow:artflow /app/media /app/staticfiles /app/backups /app/scripts \
    && chown artflow:artflow /app/ARTFLOW_RELEASE_SHA

USER artflow

EXPOSE 8000

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "120", "--graceful-timeout", "30", "--access-logfile", "-", "--error-logfile", "-"]
