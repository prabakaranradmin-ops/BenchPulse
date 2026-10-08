// Authors a trail for the ST-4.3 field test, so getting a walkable trail into the database is
// one command rather than a sequence of hand-written curl calls.
//
//   npm run seed:field-test -- --lat 13.0827 --lng 80.2707
//   npm run seed:field-test -- --lat 51.5 --lng -0.12 --pins 3 --spacing 80 --code SWAN42
//
// Prints the device keys the Unity client needs. Everything it writes goes through the same
// store and the same SR-ADMIN-01/02 validation the Admin API uses, so a trail seeded here is
// indistinguishable from one authored through the tool.

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createPostgresStore } from '../db/postgresStore.js';
import { hashDeviceKey } from '../services/deviceKey.js';
import { formatJoinCode } from '../services/joinCode.js';
import { offsetPointEast } from '../services/geo.js';
import { validateTrailDraft, type DraftPin } from '../services/trailValidation.js';
import type { NewPinInput } from '../db/types.js';

interface Options {
  lat: number;
  lng: number;
  pins: number;
  spacing: number;
  dwellSeconds: number;
  name: string;
  radiusM: number;
  code?: string;
  adminKey: string;
  playerKey: string;
}

function parseArgs(argv: string[]): Options | string {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--')) return `Unexpected argument "${flag}".`;
    const value = argv[i + 1];
    if (value === undefined) return `Flag ${flag} needs a value.`;
    flags.set(flag.slice(2), value);
  }

  const lat = Number(flags.get('lat'));
  const lng = Number(flags.get('lng'));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return '--lat is required (-90..90).';
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return '--lng is required (-180..180).';

  const pins = Number(flags.get('pins') ?? 2);
  const spacing = Number(flags.get('spacing') ?? 60);
  const radiusM = Number(flags.get('radius') ?? 10);
  const dwellSeconds = Number(flags.get('dwell') ?? 15);
  if (!Number.isInteger(pins) || pins < 1) return '--pins must be a whole number >= 1.';
  if (!Number.isFinite(spacing) || spacing <= 0) return '--spacing must be a positive distance.';
  if (!Number.isFinite(radiusM) || radiusM <= 0) return '--radius must be a positive distance.';

  return {
    lat,
    lng,
    pins,
    spacing,
    radiusM,
    dwellSeconds,
    name: flags.get('name') ?? 'Field Test Trail',
    code: flags.get('code'),
    // Reusable across runs when supplied, so a device that already holds a key keeps its player.
    adminKey: flags.get('admin-key') ?? randomBytes(24).toString('hex'),
    playerKey: flags.get('player-key') ?? randomBytes(24).toString('hex'),
  };
}

const parsed = parseArgs(process.argv.slice(2));
if (typeof parsed === 'string') {
  console.error(
    `${parsed}\n\nUsage: npm run seed:field-test -- --lat <lat> --lng <lng> [--pins 2] [--spacing 60] [--radius 10] [--dwell 15] [--code SWAN42] [--name "..."] [--admin-key <hex>] [--player-key <hex>]`,
  );
  process.exit(1);
}
const options = parsed;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set — see server/README.md.');
  process.exit(1);
}

const store = createPostgresStore(databaseUrl);
try {
  // The last pin becomes a code challenge when --code is given, so a field test can exercise
  // ST-6.2 as well as the proximity dwell.
  const draft: DraftPin[] = Array.from({ length: options.pins }, (_, index) => {
    const point = offsetPointEast(options.lat, options.lng, index * options.spacing);
    const isCodePin = options.code !== undefined && index === options.pins - 1;
    return {
      sequenceIndex: index + 1,
      lat: point.lat,
      lng: point.lng,
      radiusM: options.radiusM,
      challengeType: isCodePin ? 'code_entry' : 'proximity_dwell',
      challengeConfig: isCodePin
        ? { code: options.code, hint: 'Read the code at this location' }
        : { dwell_seconds: options.dwellSeconds },
    };
  });

  const validation = validateTrailDraft(draft);
  if (validation.errors.length > 0) {
    console.error('Refusing to seed — the trail is not playable:');
    for (const issue of validation.errors) console.error(`  [${issue.code}] ${issue.message}`);
    process.exit(1);
  }

  const admin = await store.findOrCreateUserByDeviceKeyHash(hashDeviceKey(options.adminKey));
  await store.setUserRole(admin.id, 'admin');
  const player = await store.findOrCreateUserByDeviceKeyHash(hashDeviceKey(options.playerKey));

  const trail = await store.createTrail({
    name: options.name,
    createdBy: admin.id,
    expiryDays: null,
  });
  const pins: NewPinInput[] = draft.map((pin) => ({
    sequenceIndex: pin.sequenceIndex,
    lat: pin.lat,
    lng: pin.lng,
    alt: null,
    radiusM: pin.radiusM,
    challengeType: pin.challengeType,
    challengeConfig: pin.challengeConfig ?? {},
  }));
  const published = await store.publishTrailVersion({ trailId: trail.id, pins });

  console.log(`\nSeeded "${trail.name}" (version ${published.version.versionNumber})\n`);
  console.log(`  trailId       ${trail.id}`);
  console.log(
    `  joinCode      ${formatJoinCode(trail.joinCode)}   (what a player types in the app)`,
  );
  console.log(`  playerDeviceKey  ${options.playerKey}`);
  console.log(`  adminDeviceKey   ${options.adminKey}`);
  console.log(`  playerId      ${player.id}\n`);
  console.log('  Pins (walk them in this order):');
  for (const pin of published.pins) {
    const challenge =
      pin.challengeType === 'code_entry'
        ? `code_entry, code "${String(pin.challengeConfig.code)}"`
        : `proximity_dwell, ${String(pin.challengeConfig.dwell_seconds)}s`;
    console.log(
      `    ${pin.sequenceIndex}. ${pin.lat.toFixed(6)}, ${pin.lng.toFixed(6)}  r=${pin.radiusM}m  ${challenge}`,
    );
  }

  if (validation.warnings.length > 0) {
    console.log('\n  Advisory warnings (SR-ADMIN-01/02) — seeded anyway:');
    for (const issue of validation.warnings) console.log(`    [${issue.code}] ${issue.message}`);
  }

  console.log(`
  Next, from the phone or a client:
    POST /api/v1/players/token   { "deviceKey": "${options.playerKey}" }
    GET  /api/v1/trails/${trail.id}
    POST /api/v1/attempts        { "trailId": "${trail.id}" }
`);
} catch (error) {
  console.error('Seeding failed:', error);
  process.exitCode = 1;
} finally {
  await store.close();
}
