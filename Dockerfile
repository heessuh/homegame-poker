# Base image pinned by digest (tag node:22-slim as of 2026-11-04) so the toolchain cannot change under a rebuild.
# To update: docker buildx imagetools inspect node:22-slim, then paste the new digest in both FROM lines.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
# Build identity, served at /version. Declared in this stage only, so they never touch the web build above.
ARG GIT_COMMIT=
ARG BUILD_DATE=
ENV NODE_ENV=production PORT=8080 GIT_COMMIT=$GIT_COMMIT BUILT_AT=$BUILD_DATE
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/engine/package.json ./packages/engine/
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
