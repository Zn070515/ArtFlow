# Build context is the repository root:
#   docker build -f deploy/plus/Dockerfile --target api -t artflow-plus-api .
#   docker build -f deploy/plus/Dockerfile --target web -t artflow-plus-web .

ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /src
COPY plus/package.json plus/pnpm-lock.yaml plus/pnpm-workspace.yaml ./
COPY plus/packages ./packages
COPY plus/apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm run build:prod

FROM ${NODE_IMAGE} AS api
WORKDIR /app
COPY --from=build /src/apps/api/dist/main.cjs ./main.cjs
ENV NODE_ENV=production \
    APP_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "main.cjs"]

FROM ${NGINX_IMAGE} AS web
COPY deploy/plus/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
