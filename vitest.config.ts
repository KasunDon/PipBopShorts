import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Blocks any real external network call — tests run on fakes only.
    setupFiles: ['tests/setup.ts'],
    globals: false,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
