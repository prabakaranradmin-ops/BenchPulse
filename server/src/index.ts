import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createPostgresStore } from './db/postgresStore.js';
import { createOverpassChecker } from './services/landcover.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set — see server/README.md for local Postgres+PostGIS setup.');
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  console.error('JWT_SECRET is not set — session auth (§6.8) cannot start without it.');
  process.exit(1);
}
if (jwtSecret === 'change-me' && process.env.NODE_ENV === 'production') {
  console.error(
    'JWT_SECRET is still the .env.example placeholder; refusing to start in production.',
  );
  process.exit(1);
}

// SR-ADMIN-01: OpenStreetMap water/building lookups at publish time (decision 2026-10-07).
// LANDCOVER_CHECKS=off disables them; OVERPASS_URLS (comma-separated) points at other servers.
const landcover =
  process.env.LANDCOVER_CHECKS === 'off'
    ? undefined
    : createOverpassChecker({
        endpoints: process.env.OVERPASS_URLS?.split(',')
          .map((url) => url.trim())
          .filter(Boolean),
      });

// ST-7.1: the admin web tool. ADMIN_WEB_DIR overrides where its build lives (the Docker image
// sets it); CESIUM_ION_TOKEN switches its map from flat OpenStreetMap to 3D terrain + buildings.
const adminWebDir =
  process.env.ADMIN_WEB_DIR ?? fileURLToPath(new URL('../../admin-web/dist/', import.meta.url));

const app = await buildApp({
  store: createPostgresStore(databaseUrl),
  jwtSecret,
  landcover,
  adminWeb: {
    root: adminWebDir,
    cesiumIonToken: process.env.CESIUM_ION_TOKEN?.trim() || null,
  },
  logger: true,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Closing the app runs the onClose hook, which releases the pg pool. A failure to close
    // cleanly still has to terminate the process — and say why, rather than hanging on an
    // unhandled rejection.
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  });
}

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
