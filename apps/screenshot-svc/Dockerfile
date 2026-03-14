# ── Stage 1: install deps ─────────────────────────────────────────────────────
FROM oven/bun:1.1-slim AS deps

WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json tsconfig.json openapi.json ./

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
 && chown -R appuser:appuser /app /root/.bun
USER appuser

EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]