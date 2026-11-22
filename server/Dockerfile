# Vercel Daemon: the always-on wallet watcher (src/worker.ts).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
USER node
CMD ["node_modules/.bin/tsx", "src/worker.ts"]
