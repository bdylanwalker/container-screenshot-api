# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM oven/bun:1.1-slim AS builder

WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
COPY tsconfig.json ./
RUN bun build src/server.ts --outdir dist --target bun

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY openapi.json ./

# Only Chromium needed
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
 && chown -R appuser:appuser /app /root/.bun
USER appuser

EXPOSE 3000
CMD ["bun", "run", "dist/server.js"]
```

The middle "prod deps" stage from the original is gone — Bun's output from `bun build` is a self-contained compiled file that doesn't need `node_modules` at runtime.

---

Also add `bun.lockb` to **`.dockerignore`**... actually leave it out of dockerignore since the Dockerfile copies it in. Add it to `.gitattributes` instead so Git treats it as binary:
```
bun.lockb binary diff=lockb