import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicit, not the default: Vitest 5 stopped excluding dist/, so `npm run build` output
    // would otherwise run a second copy of every test — and two copies of the Postgres suite
    // collide on the migration lock.
    include: ['src/**/*.test.ts'],
  },
});
