# Support

## Usage questions

Use [GitHub Discussions](https://github.com/gadgethd/Project-Tendril/discussions) for installation help, MCP client configuration, deployment questions, and proposed workflows.

Before asking:

1. Read the [README](README.md) and [security model](docs/security.md).
2. Run `tendril doctor`.
3. Search existing discussions and issues.
4. Reduce the problem to a minimal configuration or tool call.
5. Remove tokens, cookies, credentials, private URLs, and sensitive page content.

## Bug reports

Use the structured [bug report](https://github.com/gadgethd/Project-Tendril/issues/new?template=bug_report.yml) when behavior is reproducibly incorrect.

The issue tracker is not a support channel for bypassing CAPTCHAs, Cloudflare checks, paywalls, access controls, website terms, or rate limits.

## Security reports

Do not use issues or discussions for vulnerabilities. Follow [SECURITY.md](SECURITY.md) and submit a private GitHub security advisory.

## Scope

Project Tendril supports Node.js 22.19 and the Node.js 24 release line with Obscura 0.2.1 by default and a sandbox-capable Chromium installation as fallback. Linux, Windows, and macOS are exercised in CI; the hardened Obscura container is the recommended boundary for adversarial browsing.
