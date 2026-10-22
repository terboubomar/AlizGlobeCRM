FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci
COPY . .
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN npm run db:generate && npm run build
# The API is reached through Next's server-side proxy inside Compose.
# For other hosting, set API_URL at web build time.
FROM build AS runtime
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p /app/.data/uploads && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "apps/web"]
