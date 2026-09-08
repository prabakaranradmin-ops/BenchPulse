// ST-8.1 / SR-PRIV-01 — scheduled purge of raw location history past the retention window.
//
// Run it from cron, a Kubernetes CronJob, or whatever the deployment uses:
//   npm run job:purge-location-history          (dev, via tsx)
//   node dist/jobs/purgeLocationHistory.js      (built)
//
// Exits non-zero on failure so a scheduler can alert on it, and prints one JSON line so the
// run is greppable in logs.

import 'dotenv/config';
import { createPostgresStore } from '../db/postgresStore.js';
import { DEFAULT_RETENTION_DAYS, retentionCutoff } from '../services/retention.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set — cannot run the retention purge.');
  process.exit(1);
}

const retentionDays = Number(process.env.LOCATION_HISTORY_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
const store = createPostgresStore(databaseUrl);

try {
  const cutoff = retentionCutoff(new Date(), retentionDays);
  const deleted = await store.purgeLocationHistoryBefore(cutoff);
  console.log(
    JSON.stringify({
      job: 'purge_location_history',
      requirement: 'SR-PRIV-01',
      retentionDays,
      cutoff: cutoff.toISOString(),
      deletedRows: deleted,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ job: 'purge_location_history', error: String(error) }));
  process.exitCode = 1;
} finally {
  await store.close();
}
