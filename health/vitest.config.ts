import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // One in-memory mongod for the run; each test file uses its own database.
    globalSetup: ['test/helpers/mongoSetup.ts'],
    env: { TZ: 'America/Chicago', NODE_ENV: 'test' },
  },
});
