# ---- deps ---------------------------------------------------------------
# Production dependencies only. No native modules in this app (password
# hashing uses node:crypto scrypt, not argon2/bcrypt) so no build toolchain
# (python3/make/g++) is needed at any stage.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini is a tiny (~30KB), dependency-free init that becomes PID 1 and
# reaps zombies / forwards signals correctly — the same thing `docker run
# --init` gives you, baked into the image so it also applies under
# `docker compose up` without relying on every caller remembering the flag.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY views ./views
COPY public ./public
# Needed so `docker compose exec app node scripts/seed.js` works.
COPY scripts ./scripts

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
