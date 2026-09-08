import 'dotenv/config';
import { buildApp } from './app.js';
import { createPostgresStore } from './db/postgresStore.js';

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
  console.error('JWT_SECRET is still the .env.example placeholder; refusing to start in production.');
  process.exit(1);
}

const app = await buildApp({
  store: createPostgresStore(databaseUrl),
  jwtSecret,
  logger: true,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Closing the app runs the onClose hook, which releases the pg pool.
    app.close().then(() => process.exit(0));
  });
}

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
