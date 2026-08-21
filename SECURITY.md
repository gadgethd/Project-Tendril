# Security Policy

Project Tendril controls a real browser, processes untrusted web content, and exposes authenticated browser-control interfaces. Security reports are taken seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| Earlier versions | No |

Only the latest patch release of a supported major version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow:

<https://github.com/gadgethd/Project-Tendril/security/advisories/new>

Include:

- The affected Project Tendril version or commit.
- Operating system, Node.js version, Chromium version, and deployment model.
- The affected interface: MCP, REST, CDP, dashboard, Docker, CLI, or browser runtime.
- Reproduction steps or a minimal proof of concept.
- Expected impact and any known mitigations.
- Whether the issue is already being exploited or publicly discussed.

Remove unrelated credentials, cookies, profiles, tokens, downloads, and private browsing data. If a secret is necessary to reproduce the issue, state that in the report before transmitting it.

Maintainers will acknowledge a complete report as soon as practical, investigate it privately, and coordinate remediation and disclosure. Please allow a reasonable remediation window before public disclosure.

## Security boundaries

Project Tendril's main controls include:

- Dedicated Chromium processes and user-data directories per session.
- Public-network-only egress by default through a checked per-session proxy.
- Loopback-only HTTP binding and bearer authentication by default.
- Explicit named profiles rather than access to a user's normal browser profile.
- Canonical, workspace-restricted upload paths.
- Bounded page, network, console, and response-body output.
- Untrusted-content markers and prompt-injection warnings.
- A non-root, sandboxed Chromium container configuration.

These controls are guardrails, not a complete VM boundary. Raw CDP is intentionally powerful, persistent profiles carry the authority of their logged-in sessions, and a browser engine can contain unknown vulnerabilities. Use an additional VM or host boundary for high-risk adversarial browsing.

The full operational model is documented in [docs/security.md](docs/security.md).

## Out of scope

The following are not vulnerabilities in Project Tendril:

- A website detecting that it is being automated.
- A website denying, throttling, or blocking automated traffic.
- Actions performed by a client already holding the Tendril bearer token or CDP URL.
- Prompt injection being present in page content that is already marked untrusted.
- Private-network access after an operator explicitly disables the default block.
- Attacks that require a modified Project Tendril binary or pre-existing host compromise.

Challenge resolution (CAPTCHAs, bot challenges) is an opt-in local capability. Reports about bypassing third-party access controls, paywalls, or bot protections via external services will not be accepted. Reports about improving local challenge resolution are welcome.
