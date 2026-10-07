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
import { joinRoutes } from './routes/join.js';
import { noLandcoverChecks, type LandcoverChecker } from './services/landcover.js';

declare module 'fastify' {
  interface FastifyInstance {
    store: TrailStore;
    landcover: LandcoverChecker;
  }
}

export interface BuildAppOptions {
  store: TrailStore;
  jwtSecret: string;
  /** SR-ADMIN-01 water/building lookups. Off unless given — index.ts wires the live Overpass one. */
  landcover?: LandcoverChecker;
  logger?: FastifyServerOptions['logger'];
  /** SR-SEC-03: basic per-user rate limit on the pin/progress API. `false` disables it. */
  rateLimit?: { max: number; timeWindow: string | number } | false;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: {
      customOptions: {
        // Fastify's defaults would quietly strip unknown fields (making every
        // `additionalProperties: false` a no-op) and coerce types — so `accuracyM: null` became
        // 0, *perfect* accuracy, in the location history SR-SEC-02 judges movement from. Bodies
        // must say exactly what they mean; anything else is a 400 the client can see and fix.
        removeAdditional: false,
        coerceTypes: false,
      },
    },
  });
  app.decorate('store', options.store);
  app.decorate('landcover', options.landcover ?? noLandcoverChecks);
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
  await app.register(joinRoutes);
  await app.register(adminRoutes);
  await app.register(trailRoutes);
  await app.register(attemptRoutes);
  await app.register(pinRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
