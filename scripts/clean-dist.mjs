// Remove build output before `bun run build`.
//
// tsup rewrites entry files but never deletes chunks whose hash is gone, so a
// stale `va.client-<hash>.d.ts` / `chunk-<hash>.js` survives every rebuild and
// ships with the package (`files[]` includes the whole dist tree). Wiping the
// dirs first keeps the tarball to exactly the chunks this build emitted.
//
// Runs via the `prebuild` lifecycle hook, so `build` and `prepublishOnly`
// both start from a clean slate.

import { rmSync } from 'node:fs';

for (const dir of ['packages/client/dist', 'packages/cli/dist']) {
  rmSync(dir, { recursive: true, force: true });
}
