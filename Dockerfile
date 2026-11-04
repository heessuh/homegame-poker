FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/engine/package.json ./packages/engine/
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
