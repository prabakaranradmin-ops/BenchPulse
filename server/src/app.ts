// Application wiring, separated from index.ts so tests can build an app around an in-memory
// store (src/db/memoryStore.ts) instead of a live Postgres+PostGIS instance.

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { TrailStore } from './db/types.js';
import { trailRoutes } from './routes/trails.js';
import { attemptRoutes } from './routes/attempts.js';
import { pinRoutes } from './routes/pins.js';
import { playerRoutes } from './routes/players.js';
import { adminRoutes } from './routes/admin.js';

declare module 'fastify' {
  interface FastifyInstance {
    store: TrailStore;
  }
}

export interface BuildAppOptions {
  store: TrailStore;
  jwtSecret: string;
  logger?: FastifyServerOptions['logger'];
  /** SR-SEC-03: basic per-user rate limit on the pin/progress API. `false` disables it. */
  rateLimit?: { max: number; timeWindow: string | number } | false;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  app.decorate('store', options.store);
  app.addHook('onClose', async () => {
    await options.store.close();
  });

  await app.register(jwt, { secret: options.jwtSecret });

  if (options.rateLimit !== false) {
    await app.register(rateLimit, {
      max: options.rateLimit?.max ?? 120,
      timeWindow: options.rateLimit?.timeWindow ?? '1 minute',
      // preHandler rather than the default onRequest so the route's `authenticate` hook has
      // already run and the limit can be keyed per player rather than per IP (SR-SEC-03) —
      // several players behind one carrier NAT must not share a bucket. The tradeoff: requests
      // rejected at `authenticate` never reach this hook, so unauthenticated flooding is an
      // edge/proxy concern, not something this limiter covers.
      hook: 'preHandler',
      keyGenerator: (request) => request.user?.sub ?? request.ip,
    });
  }

  await app.register(playerRoutes);
  await app.register(adminRoutes);
  await app.register(trailRoutes);
  await app.register(attemptRoutes);
  await app.register(pinRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
