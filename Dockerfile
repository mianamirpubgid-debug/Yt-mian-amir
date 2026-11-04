# ---------- Builder ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# ---------- Runner ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# Chromium ke system deps (playwright --with-deps khud install karega, lekin base certs pehle)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    CHROME_PATH=/opt/ms-playwright/chromium-1200/chrome-linux/chrome

# Playwright chromium (1.57.0 = chromium-1200, app ke playwright-core se match)
RUN npx -y playwright@1.57.0 install --with-deps chromium

# Standalone output (build script static + public already copy karta hai)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 3000
CMD ["/usr/local/bin/start.sh"]
