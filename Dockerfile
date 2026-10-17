# Portable production image for SenIQ. Works on any Docker host; deploy/ runs it on AWS.
# Debian slim, not Alpine: FinBERT's runtime (onnxruntime-node) ships builds for standard
# Linux only, and on Alpine the app would quietly fall back to the word list.
FROM node:20-slim

# dumb-init reaps zombies and forwards SIGTERM so graceful shutdown actually fires.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

# Install prod deps first for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# FinBERT (~110 MB) baked in at build time. At run time the app runs as `node`, which cannot
# write under node_modules, so a first-use download would fail.
RUN node -e "import('@huggingface/transformers').then(({ pipeline }) => pipeline('text-classification', 'Xenova/finbert', { dtype: 'q8' })).then(() => console.log('FinBERT cached'))"

# App source.
COPY . .

# Run as the built-in non-root user.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
