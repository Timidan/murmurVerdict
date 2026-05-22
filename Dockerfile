FROM node:22-slim

# build tools needed by `better-sqlite3` native install on slim images.
# resvg-js ships prebuilt linux/x64 binaries; no extra system deps required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps && npm cache clean --force

COPY --chown=node:node . .

# Persistent SQLite mount target — docker-compose.yml mounts the
# `verdict_data` named volume here. Litestream replicates the WAL from
# this directory off-host.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 8080
CMD ["npm", "start"]
