/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference path="../worker-configuration.d.ts" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.integration.config.ts so migrations apply from scratch. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
