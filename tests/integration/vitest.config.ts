// @polsia:user-owned — Opt-in Vitest config for source-level integration contracts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/alerts-export.test.ts'],
  },
});
