// EPIC 7 — promote a player to Admin, or demote one back.
//
//   npm run grant-admin -- <userId>
//   npm run grant-admin -- <userId> player     # demote
//
// Deliberately a CLI and not an endpoint: there is no self-service path to authoring rights,
// so a stolen player token can never escalate into one.

import 'dotenv/config';
import { createPostgresStore } from '../db/postgresStore.js';

const [userId, roleArg = 'admin'] = process.argv.slice(2);

if (!userId) {
  console.error('Usage: npm run grant-admin -- <userId> [admin|player]');
  process.exit(1);
}
if (roleArg !== 'admin' && roleArg !== 'player') {
  console.error(`Role must be "admin" or "player", got "${roleArg}".`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const store = createPostgresStore(databaseUrl);
try {
  const user = await store.setUserRole(userId, roleArg);
  if (!user) {
    console.error(`No player with id ${userId}.`);
    process.exitCode = 1;
  } else {
    console.log(`${user.id} is now ${user.role}.`);
  }
} finally {
  await store.close();
}
