import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { TZ: 'America/Chicago', NODE_ENV: 'test' },
  },
});
