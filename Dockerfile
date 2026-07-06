# Portable production image for SenIQ. Works on Fly.io, a VPS, or Render-as-Docker —
# host-agnostic so it doesn't lock in the hosting decision (render.yaml covers Render natively).
FROM node:20-alpine

# dumb-init reaps zombies and forwards SIGTERM so graceful shutdown actually fires.
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production
WORKDIR /app

# Install prod deps first for layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Run as the built-in non-root user.
USER node

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
