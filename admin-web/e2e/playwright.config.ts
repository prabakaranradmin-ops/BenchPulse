import { defineConfig } from '@playwright/test';

// Browser tests for the admin tool, against a real server that serves the built tool at /admin/
// (CI's admin-e2e job; locally see admin-web/README.md). The 3D map needs WebGL, which headless
// Chromium provides through SwiftShader.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: '../test-results',
  use: {
    baseURL: process.env.ADMIN_E2E_URL ?? 'http://127.0.0.1:3000',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
});
