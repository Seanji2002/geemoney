import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Fresh, migrated database for every test.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
