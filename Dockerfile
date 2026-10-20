# headless-duckapi — Node 24 has SQLite built in, so the image is dependency-free
# (node:sqlite). No build tools, no native modules, ~180 MB.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first (cached layer). better-sqlite3 is an optional
# fallback for old Node runtimes — not needed on Node 24, so skip optional deps.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional

COPY . .

# Run as a non-root user; data volume is pre-created with proper ownership.
RUN useradd -m bot && mkdir -p /app/data && chown -R bot:bot /app
USER bot

ENV DATA_DIR=/app/data
ENV PORT=8080
VOLUME /app/data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
