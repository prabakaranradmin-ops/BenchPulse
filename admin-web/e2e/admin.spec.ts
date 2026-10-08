// The admin tool in a real browser, against a real server. Unit tests can't see the failures that
// matter most here — a CSP that blocks the map, a WebGL scene that doesn't redraw — so any console
// error or uncaught exception fails the test.
//
// Hermetic: every request that isn't to the server under test is aborted. CI never touches
// OpenStreetMap's tile or search servers (their usage policies don't welcome automated traffic),
// and an outage there can't fail the build. The map is then a bare globe, which is all that
// placing pins needs.

import { randomBytes } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const ADMIN_KEY = process.env.ADMIN_E2E_KEY ?? '';

let problems: string[] = [];

test.beforeEach(async ({ context, page, baseURL }) => {
  expect(
    ADMIN_KEY,
    'ADMIN_E2E_KEY: a device key promoted to Admin on the server under test',
  ).toMatch(/^[0-9a-f]{64}$/);
  const origin = new URL(baseURL ?? '').origin;
  await context.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );

  problems = [];
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    // The external requests this test aborts on purpose.
    if (message.text().startsWith('Failed to load resource') && !source.startsWith(origin)) return;
    problems.push(`console: ${message.text()} (${source})`);
  });
});

test.afterEach(() => {
  expect(problems, 'errors in the browser').toEqual([]);
});

test('an Admin places pins, sets a code, publishes, and shares the trail', async ({
  page,
  request,
}) => {
  const name = `E2E walk ${Date.now()}`;
  await signIn(page);

  await page.getByLabel('New trail name').fill(name);
  await page.getByRole('button', { name: 'New trail' }).click();
  const map = page.locator('.cesium-container canvas').first();
  await expect(map).toBeVisible();

  // Coordinates rather than a place name: place search would leave the test environment.
  await page.getByLabel('Go to a place or coordinates').fill('13.0500, 80.2824');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForTimeout(2500);

  await page.getByRole('button', { name: 'Add pins' }).click();
  const box = await map.boundingBox();
  if (!box) throw new Error('The map has no size.');
  for (const [x, y] of [
    [0.35, 0.6],
    [0.5, 0.45],
    [0.65, 0.55],
  ]) {
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  }
  await page.keyboard.press('Escape');
  const pinItems = page.locator('.pin-list li');
  await expect(pinItems).toHaveCount(3);
  await expect(pinItems.first()).toContainText('13.0');

  // The live placement check (SR-ADMIN-01) flags a code pin with no code, then clears.
  await pinItems.nth(1).getByRole('button').click();
  await page.getByLabel('Challenge').selectOption('code_entry');
  await expect(page.getByText('is a code challenge with no code set').first()).toBeVisible();
  await page.getByPlaceholder('e.g. SWAN42').fill('SWAN42');
  await expect(page.getByText('Ready to publish. No problems found.')).toBeVisible();

  // Unpublished edits survive a reload of the tab.
  await page.reload();
  await expect(page.getByText('Restored the unpublished changes')).toBeVisible();
  await expect(pinItems).toHaveCount(3);
  await expect(page.getByText('Ready to publish. No problems found.')).toBeVisible();

  await page.locator('.panel-footer').getByRole('button', { name: 'Publish version 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish version 1' }).click();
  await expect(page.getByText('Version 1 is live')).toBeVisible();
  await expect(page.getByText('No unpublished changes')).toBeVisible();

  const joinCode = (await page.locator('.code-chip').first().innerText()).trim();
  expect(joinCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  await page.getByRole('button', { name: 'QR code' }).click();
  await expect(page.locator('.qr img')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // What was published is what a player gets — and the code never leaves the server.
  const player = await tokenFor(request, randomBytes(32).toString('hex'));
  const joined = await request.get(`/api/v1/join/${joinCode}`, { headers: bearer(player) });
  expect(joined.status()).toBe(200);
  const { trailId, pinCount } = (await joined.json()) as { trailId: string; pinCount: number };
  expect(pinCount).toBe(3);
  const trail = await request.get(`/api/v1/trails/${trailId}`, { headers: bearer(player) });
  const body = await trail.text();
  expect(body).toContain('code_entry');
  expect(body).not.toContain('SWAN42');
});

test("a player's report reaches the queue, opens on the map, and is resolved", async ({
  page,
  request,
}) => {
  const name = `E2E report ${Date.now()}`;
  const note = `Hoarding over the plaque ${Date.now()}`;
  const admin = await tokenFor(request, ADMIN_KEY);
  const created = await request.post('/api/v1/admin/trails', {
    headers: bearer(admin),
    data: { name },
  });
  const { trailId } = (await created.json()) as { trailId: string };
  const published = await request.post(`/api/v1/admin/trails/${trailId}/versions`, {
    headers: bearer(admin),
    data: {
      pins: [
        {
          sequenceIndex: 1,
          lat: 13.05,
          lng: 80.28,
          radiusM: 10,
          challengeType: 'proximity_dwell',
          challengeConfig: { dwell_seconds: 15 },
        },
        {
          sequenceIndex: 2,
          lat: 13.0527,
          lng: 80.282,
          radiusM: 10,
          challengeType: 'proximity_dwell',
          challengeConfig: { dwell_seconds: 15 },
        },
      ],
    },
  });
  expect(published.status()).toBe(201);
  const player = await tokenFor(request, randomBytes(32).toString('hex'));
  const attempt = await request.post('/api/v1/attempts', {
    headers: bearer(player),
    data: { trailId },
  });
  const { pins } = (await attempt.json()) as { pins: { pinId: string }[] };
  const report = await request.post(`/api/v1/pins/${pins[0].pinId}/report`, {
    headers: bearer(player),
    data: { note },
  });
  expect(report.status()).toBe(201);

  await signIn(page);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: note });
  await expect(row).toContainText(name);
  await expect(row).toContainText('Pin 1');

  await row.getByRole('link', { name: 'Show on map' }).click();
  await expect(page.locator('.pin-item.selected')).toContainText('13.050000, 80.280000');
  await expect(page.locator('.cesium-container canvas').first()).toBeVisible();

  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: note })
    .getByRole('button', { name: 'Resolve', exact: true })
    .click();
  await expect(page.getByRole('row').filter({ hasText: note })).toHaveCount(0);

  await page.getByRole('link', { name: 'Analytics', exact: true }).click();
  await page.getByRole('row').filter({ hasText: name }).click();
  await expect(page.getByText('Where players stop')).toBeVisible();
  await expect(page.locator('.funnel-row').first()).toContainText('Pin 1');
});

async function signIn(page: Page) {
  await page.goto('/admin/');
  await page.getByLabel('Admin key').fill(ADMIN_KEY);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Trails' })).toBeVisible();
}

async function tokenFor(request: APIRequestContext, deviceKey: string): Promise<string> {
  const response = await request.post('/api/v1/players/token', { data: { deviceKey } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}
