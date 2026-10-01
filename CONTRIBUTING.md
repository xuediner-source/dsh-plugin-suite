# Maintaining the suite

Every package in `packages/` remains an independently installable DSH bundle. Changes belong to the package that owns the behavior; the workspace root only coordinates development, audit, testing and packaging. Keep the original source provenance and individual copyright notices.

Before adding a feature, compare it to the currently pinned DSH source. Use native compaction, credentials, lifecycle and workflow services where available. Do not duplicate a native engine or silently take ownership of an existing provider ID. Document the exact upstream version reviewed and distinguish source findings from applied suite repairs.

For each changed package, fix the actual behavior, update its README, and add useful regressions for compatibility, failures and unload/cancellation where relevant. A retained standalone package is subject to the same requirement. Tests must use isolated temporary state and mock network endpoints. Do not use personal credentials, change real profiles, or treat fixture token/usage values as actual measurements.

Use the root npm lockfile. `docs/source-locks/` contains preserved historical pnpm locks only. Never commit `node_modules`, runtime state, auth files, secrets, private keys or generated archives. The JS packages author source directly in `lib/`; TypeScript packages author `src/` and generate `lib/` at build time.

Required gates:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm run check
npm test
npm run pack:plugins
```

Version and document each changed package before preparing release artifacts. Inspect the archive contents and SHA-256 manifest. Publish only after all required gates pass; GitHub CI uploads the checked independent packages for inspection. Do not publish the private workspace root to npm.
