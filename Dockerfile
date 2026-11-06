# Node 24 ships the built-in SQLite module the bot uses (no native add-ons to compile, so it also builds on ARM NAS models).
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Database + backups live here; mount a volume on /app/data to keep them across updates.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

CMD ["node", "--no-warnings", "src/index.js"]
