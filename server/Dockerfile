# syntax=docker/dockerfile:1

# The server as a single deployable artifact. Deliberately host-neutral: this runs the same
# behind a Cloudflare Tunnel, on a VPS, or on a PaaS — TLS termination is the host's job
# (§6.8 requires TLS 1.3 in front of this, which is why the app itself speaks plain HTTP).

# --- build: full dependency tree, compiles TypeScript ------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime: production dependencies and compiled output only ----------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations ship with the image so a host's release step can run `npm run migrate` against
# the exact code being deployed, rather than against whatever a workstation had checked out.
COPY migrations ./migrations

# node:alpine ships an unprivileged `node` user; nothing here needs to write to the filesystem.
USER node
EXPOSE 3000

# Hits the same /health route a load balancer would.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node receives SIGTERM as PID 1 here, which src/index.ts handles: it closes Fastify, which
# releases the pg pool via the onClose hook.
CMD ["node", "dist/index.js"]
