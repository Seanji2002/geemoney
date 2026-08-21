import type { Env } from '../src/config';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
