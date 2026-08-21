# Contributing to Project Tendril

Thank you for helping improve Project Tendril. Contributions are accepted under the Apache License 2.0.

## Before you start

- Search existing issues and pull requests.
- For a substantial feature or security-boundary change, open a feature request before investing in an implementation.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Read [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md).

Project Tendril will not accept features that automate CAPTCHA solving, disguise browser automation, evade fingerprinting or bot protection, bypass access controls or paywalls, add hosted telemetry, attach to normal browser profiles implicitly, or enable private-network access by default.

## Development environment

Requirements:

- Node.js 22.19 or newer.
- npm with lockfile support.
- Chromium, Google Chrome, or Playwright-managed Chromium.
- A non-root user with a functioning browser sandbox.

Set up the repository:

```bash
git clone https://github.com/gadgethd/Project-Tendril.git
cd Project-Tendril
npm ci
npm run build
node dist/cli.js doctor
```

Install Playwright-managed Chromium when needed:

```bash
npx playwright install chromium --with-deps
```

On Windows and macOS, omit `--with-deps`.

## Making a change

1. Create a focused branch from `main`.
2. Keep changes narrowly scoped and preserve existing security defaults.
3. Add deterministic tests for behavior and failure boundaries.
4. Mark all browser-derived output as untrusted.
5. Bound newly exposed page, network, filesystem, or diagnostic data.
6. Update README, architecture, security, and changelog documentation when applicable.
7. Run the complete local verification suite.

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The tests launch real Chromium. A browser-only mock is not sufficient for changes involving navigation, CDP, process cleanup, proxies, snapshots, or browser actions.

## Design expectations

### MCP tools

- Prefer a small, composable tool with structured output over a large free-form tool.
- Use Zod input validation and accurate MCP tool annotations.
- Describe whether a tool reads untrusted web content or causes an external side effect.
- Keep output bounded and return source URLs when producing evidence.
- Invalidate element refs whenever page state can make them unsafe.

### Browser lifecycle

- Keep one dedicated Chromium process and user-data directory per Tendril session.
- Terminate the complete browser process group.
- Delete ephemeral state even when launch or shutdown fails.
- Never use the user's normal Chrome or Chromium profile.
- Preserve Chromium's native sandbox.

### Network and filesystem

- Route browser traffic through the checked per-session proxy.
- Re-check redirects and subresources.
- Keep private, loopback, metadata, reserved, and non-HTTP(S) destinations blocked by default.
- Canonicalize upload paths and enforce workspace roots after symlink resolution.
- Never log tokens, cookies, authorization headers, credentials, page bodies, or downloads by default.

### Web content

- Treat page text, accessibility labels, metadata, search snippets, and documents as untrusted data.
- Do not turn webpage instructions into trusted Project Tendril behavior.
- Do not add stealth patches, CAPTCHA solvers, clearance synthesis, or automated challenge outsourcing.
- Respect `robots.txt` in research and crawl workflows.

## Pull requests

Pull requests should include:

- A concise explanation of the user or agent problem.
- The chosen implementation and important trade-offs.
- Security and privacy impact.
- Tests performed.
- Documentation changes.
- A changelog entry for user-visible behavior.

Keep unrelated refactoring out of a behavioral pull request. Reviewers may request smaller commits or separate pull requests.

All CI checks must pass on Linux, Windows, and macOS. The Docker job must also build and launch sandboxed Chromium successfully.

## Commit messages

Use short, imperative commit subjects. Examples:

```text
Add bounded response-body inspection
Fix profile cleanup after launch failure
Document Streamable HTTP authentication
```

Reference an issue in the pull request description rather than forcing every commit to carry issue metadata.

## Documentation

Use **Project Tendril** for the product and project name. Use `Project-Tendril` only for the GitHub repository/folder name, and `project-tendril` only where lowercase machine identifiers are required, such as npm package names, image tags, and data directories.

Examples should be safe to copy:

- Bind network services to loopback.
- Show bearer authentication for protected endpoints.
- Keep private-network access disabled.
- Use a non-root browser process.
- Avoid including real credentials or cookies.

## Licensing

By submitting a contribution, you agree that it is licensed under the repository's Apache License 2.0. Do not submit code, fixtures, media, or documentation you do not have the right to license.

## Code of Conduct

All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md).
