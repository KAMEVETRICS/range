FROM node:22-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
USER node

FROM runtime AS web-build
USER root
RUN pnpm --filter @range/web build

FROM nginx:1.29-alpine AS dashboard
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
