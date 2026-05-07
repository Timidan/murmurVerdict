FROM node:20-slim

# build tools needed by `better-sqlite3` native install on slim images
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps && npm cache clean --force

COPY --chown=node:node . .

# Persistent SQLite mount target — render.yaml mounts a 1 GB disk here.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 8080
CMD ["npm", "start"]
