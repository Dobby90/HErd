FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS node-runtime

FROM node-runtime AS build
RUN npm install --global pnpm@10.11.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ARG HERD_VERSION=dev
ARG VITE_ERD_PNG_MAX_SIDE
ARG VITE_ERD_PNG_MAX_PIXELS
RUN VITE_HERD_VERSION="$HERD_VERSION" pnpm build && pnpm --filter @erd/api --prod deploy --legacy /runtime

FROM node-runtime AS api
ARG HERD_VERSION=dev
ARG HERD_REVISION=unknown
LABEL org.opencontainers.image.version=$HERD_VERSION \
      org.opencontainers.image.revision=$HERD_REVISION
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3001
WORKDIR /app
COPY --from=build /runtime/package.json ./
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /app/dist/api ./dist/api
COPY db/migrations ./db/migrations
USER node
EXPOSE 3001
CMD ["node", "dist/api/main.js"]

FROM nginx:stable-alpine@sha256:3bc3836dc0be3b811f238210360bf8e7ca8a2d0effdae46160bf1f3578710051 AS web
ARG HERD_VERSION=dev
ARG HERD_REVISION=unknown
LABEL org.opencontainers.image.version=$HERD_VERSION \
      org.opencontainers.image.revision=$HERD_REVISION
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist/web /usr/share/nginx/html
RUN chown -R nginx:nginx /var/cache/nginx
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]

FROM postgres:17.12-bookworm@sha256:837bed18782820fe967067cb5328b02b0d9992c1be9a37ee0c9c492cfc03af3b AS verify
COPY --from=node-runtime /usr/local/ /usr/local/
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.11.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENTRYPOINT []
CMD ["pnpm", "test"]
