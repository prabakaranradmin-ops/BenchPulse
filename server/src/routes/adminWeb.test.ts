import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../testSupport/harness.js';
import { ADMIN_WEB_CSP } from './adminWeb.js';

let workspace: string;
let root: string;

beforeAll(() => {
  // A secret beside the build directory: what a path-traversal request would be after.
  workspace = mkdtempSync(path.join(tmpdir(), 'admin-web-'));
  root = path.join(workspace, 'dist');
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  mkdirSync(path.join(root, 'cesium', 'Workers'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Trail Admin</title>');
  writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'console.log("admin")');
  writeFileSync(path.join(root, 'cesium', 'Workers', 'decode.js'), 'self.onmessage = () => {}');
  writeFileSync(path.join(root, '.env'), 'JWT_SECRET=hidden');
  writeFileSync(path.join(workspace, 'secret.txt'), 'outside the build');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let ctx: TestApp | undefined;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

describe('the admin web tool at /admin/ (ST-7.1)', () => {
  it('redirects /admin to /admin/, so relative asset paths resolve', async () => {
    ctx = await buildTestApp({}, { adminWeb: { root } });

    const response = await ctx.app.inject({ method: 'GET', url: '/admin' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/admin/');
  });

  it('serves the page with a same-origin-only script policy', async () => {
    ctx = await buildTestApp({}, { adminWeb: { root } });

    const response = await ctx.app.inject({ method: 'GET', url: '/admin/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Trail Admin');
    expect(response.headers['content-security-policy']).toBe(ADMIN_WEB_CSP);
    expect(ADMIN_WEB_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // Revalidated every load, so a deploy is picked up straight away.
    expect(response.headers['cache-control']).toContain('max-age=0');
  });

  it('caches fingerprinted assets for good, and nothing else', async () => {
    ctx = await buildTestApp({}, { adminWeb: { root } });

    const asset = await ctx.app.inject({ method: 'GET', url: '/admin/assets/index-abc123.js' });
    const cesium = await ctx.app.inject({ method: 'GET', url: '/admin/cesium/Workers/decode.js' });

    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(cesium.statusCode).toBe(200);
    expect(cesium.headers['cache-control']).not.toContain('immutable');
  });

  it('never serves a file from outside the build directory, or a dotfile inside it', async () => {
    ctx = await buildTestApp({}, { adminWeb: { root } });

    for (const url of [
      '/admin/../secret.txt',
      '/admin/%2e%2e/secret.txt',
      '/admin/assets/%2e%2e/%2e%2e/secret.txt',
      '/admin/..%2fsecret.txt',
      '/admin/.env',
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.body, url).not.toContain('outside the build');
      expect(response.body, url).not.toContain('hidden');
    }
  });

  it('answers a missing file with a 404', async () => {
    ctx = await buildTestApp({}, { adminWeb: { root } });

    const response = await ctx.app.inject({ method: 'GET', url: '/admin/assets/nope.js' });

    expect(response.statusCode).toBe(404);
  });

  it("explains how to build the tool when it hasn't been built", async () => {
    ctx = await buildTestApp({}, { adminWeb: { root: path.join(workspace, 'not-built') } });

    const response = await ctx.app.inject({ method: 'GET', url: '/admin/' });

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('npm run build');
  });

  it('is exempt from the API rate limit, which loading the 3D map would otherwise trip', async () => {
    ctx = await buildTestApp(
      {},
      { adminWeb: { root }, rateLimit: { max: 2, timeWindow: '1 minute' } },
    );

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/admin/cesium/Workers/decode.js',
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });
});

describe('GET /api/v1/admin/config', () => {
  it('gives an Admin the map token', async () => {
    ctx = await buildTestApp({}, { adminWeb: { root, cesiumIonToken: 'ion-token' } });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/config',
      headers: ctx.adminHeader('admin-1'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cesiumIonToken: 'ion-token' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports no token as null, which means the flat OpenStreetMap map', async () => {
    ctx = await buildTestApp();

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/config',
      headers: ctx.adminHeader('admin-1'),
    });

    expect(response.json()).toEqual({ cesiumIonToken: null });
  });

  it('keeps the billed token from players and from anyone signed out', async () => {
    ctx = await buildTestApp({}, { adminWeb: { root, cesiumIonToken: 'ion-token' } });

    const player = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/config',
      headers: ctx.authHeader('player-1'),
    });
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/config' });

    expect(player.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
    expect(player.body + anonymous.body).not.toContain('ion-token');
  });
});
