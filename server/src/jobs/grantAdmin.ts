// EPIC 7 — Admin access, managed from the command line only.
//
//   npm run admin:new-key                      # mint a brand-new Admin and print its sign-in key
//   npm run grant-admin -- <userId>            # promote an existing player
//   npm run grant-admin -- <userId> player     # demote
//
// Deliberately a CLI and not an endpoint: there is no self-service path to authoring rights,
// so a stolen player token can never escalate into one.

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createPostgresStore } from '../db/postgresStore.js';
import { hashDeviceKey } from '../services/deviceKey.js';

const args = process.argv.slice(2);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

if (args[0] === '--new-key') {
  // The Admin web app signs in the way players do — by exchanging a device key for a session
  // token — so an Admin "account" is a key. Only its hash is stored; this is the one time the
  // key itself is ever shown. Treat it like a password.
  const key = randomBytes(32).toString('hex');
  const store = createPostgresStore(databaseUrl);
  try {
    const admin = await store.findOrCreateUserByDeviceKeyHash(hashDeviceKey(key));
    await store.setUserRole(admin.id, 'admin');
    console.log(`\nNew Admin ${admin.id}\n`);
    console.log(`  Sign-in key: ${key}\n`);
    console.log('Paste it into the Admin web app (/admin/). It is shown only once; to revoke it,');
    console.log(`run: npm run grant-admin -- ${admin.id} player\n`);
  } finally {
    await store.close();
  }
} else {
  const [userId, roleArg = 'admin'] = args;
  if (!userId) {
    console.error(
      'Usage: npm run admin:new-key  |  npm run grant-admin -- <userId> [admin|player]',
    );
    process.exit(1);
  }
  if (roleArg !== 'admin' && roleArg !== 'player') {
    console.error(`Role must be "admin" or "player", got "${roleArg}".`);
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
}
