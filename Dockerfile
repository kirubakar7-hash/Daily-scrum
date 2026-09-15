# Builds the React frontend, then packages it together with the API server into one
# deployable image. The server serves both the built frontend and the /api routes,
# so the whole app runs as a single service with one URL.

FROM node:24-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=client-build /app/client/dist /app/client/dist

EXPOSE 4000
CMD ["node", "src/index.js"]
