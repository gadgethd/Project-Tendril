# Dependency Update Report

Date: 2026-08-29  
Repository: `gadgethd/Project-Tendril`  
Branch: `main`

## Dependabot pull requests

### PR #5 — production dependency group

- URL: https://github.com/gadgethd/Project-Tendril/pull/5
- Changes reviewed:
  - `commander` 14.0.3 → 15.0.0 (major)
  - `zod` 3.25.76 → 4.4.3 (major)
- Compatibility review:
  - Commander 15 is ESM-only and requires Node.js 22.12 or newer. Tendril is already ESM and declares Node.js 22.19 or newer.
  - Tendril uses standard Commander APIs, and the CLI compiled and passed a `--help` smoke test.
  - Tendril's Zod schemas compiled under Zod 4, and the full test suite passed after the host-specific Chromium sandbox setting was enabled.
- CI status before merge: all checks passed on Ubuntu, macOS, Windows, Docker/Chromium, and CodeQL.
- Result: safely squash-merged as commit `61c0df0`.

No Dependabot pull requests remained open after the merge.

## Additional dependency audit

`npm outdated` found two remaining direct minor updates after PR #5 was merged:

- `zod` 4.4.3 → 4.5.2
- `@types/node` 26.2.0 → 26.4.0

Both were updated in `package.json` and `package-lock.json`. No dependencies were added, and no unrelated lockfile changes were made. A follow-up `npm outdated --json --long` returned an empty result.

Dependabot already covers npm, GitHub Actions, and Docker. The workflow action references use the current major release lines (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`, `docker/setup-buildx-action@v4`, `docker/build-push-action@v7`, and `github/codeql-action@v4`). The Dockerfile uses the floating Node 22 Bookworm slim tag, so no minor/patch manifest edit was needed.

`npm audit` reported 0 vulnerabilities across 261 audited dependency entries.

## Verification

- `npm ci`: passed
- `npm run build`: passed
- Initial `npm test`: Chromium-backed tests could not launch because this host disables unprivileged user namespaces.
- `TENDRIL_ALLOW_NO_SANDBOX=true npm test`: passed, 8 test files and 26 tests
- `node dist/cli.js --help`: passed

The no-sandbox setting was limited to the local test process and is the documented requirement for Chromium on this host.
