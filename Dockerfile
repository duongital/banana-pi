# Runs TypeScript directly on Bun (bun:sqlite used by the opencode adapter).
FROM oven/bun:1.4.3-alpine

WORKDIR /app

# Install deps first for better layer caching (client is bundled at startup).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV PORT=4241
ENV HOST=0.0.0.0
# Default mount points inside the container.
ENV PI_SESSIONS_DIR=/agents/pi
ENV OPENCODE_SESSIONS_DIR=/agents/opencode
ENV CLAUDE_SESSIONS_DIR=/agents/claude

EXPOSE 4241

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:4241/healthz || exit 1

CMD ["bun", "src/index.ts"]
