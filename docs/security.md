# Security model

Tendril assumes every page and every MCP tool argument can be hostile. It provides guardrails, not a complete VM boundary.

## Network

Every Chromium session uses a dedicated forward proxy. The proxy resolves hostnames itself and connects to the vetted IP, preventing a second browser-side DNS resolution. By default it rejects loopback, private, link-local, multicast, reserved, carrier-grade NAT, and cloud metadata destinations for both HTTP and HTTPS CONNECT tunnels. Redirects and subresource hosts create new proxy requests and are checked again.

Explicit `allowedHosts` entries may reach private addresses and override the private-network check. `blockedHosts` wins over the allowlist. `file:`, `data:`, and other navigation protocols are rejected by the high-level API. Chromium extensions, background networking, and non-proxied WebRTC UDP are disabled.

Raw CDP remains powerful. An authorized CDP client controls its browser process and should be treated like an authorized shell inside that browser profile.

## Profiles and credentials

Tendril never attaches to the user's normal Chrome profile. Ephemeral sessions are the default. Named profiles are opt-in, stored separately, and locked to one live session. A page opened in an authenticated profile can act with that profile's authority, so profiles should be narrow and task-specific.

HTTP, REST, metrics, and CDP require a random bearer token and bind to loopback by default. Host-header checks reduce DNS-rebinding exposure. Stdio MCP does not need a token because the client owns its child process.

## Filesystem

Uploads are restricted to configured workspace roots after resolving symlinks and canonical paths. Downloads remain in Chromium's session-scoped storage. The Docker deployment runs non-root with a read-only root filesystem, only the `SYS_CHROOT` capability retained for Chromium's sandbox, tmpfs runtime storage, and the supplied Chromium-compatible seccomp profile when invoked as documented. Docker's `no-new-privileges` option is intentionally incompatible with Chromium's setuid sandbox and must not be added.

## Prompt injection

Accessibility labels, hidden text, search snippets, and documents are untrusted content. Tendril returns them in structured fields with `untrustedContent: true` and warns on common instruction-override and exfiltration phrases. Detection is heuristic and cannot make arbitrary web content safe. MCP hosts should maintain an instruction/data boundary and require approval for sensitive actions.

## Logs and telemetry

Tendril has no telemetry. Structured logs redact credentials embedded in URLs and sensitive query keys. Cookies, authorization headers, response bodies, and page content are not logged by default.

## Challenge handling

Tendril detects common challenge pages (Cloudflare, Turnstile, reCAPTCHA, hCaptcha, and others) and pauses for a human to complete the challenge in a headed session. Legitimately issued clearance cookies remain in that session or named profile for their normal server-defined lifetime. Tendril does not automate challenge solving, outsource solving, synthesize challenge tokens, copy clearance between devices, or apply stealth patches.

## Out of scope

Tendril does not bypass paywalls, access controls, robots.txt in crawl/research mode, or browser security warnings. Native mode relies on Chromium's sandbox and the operating system. Use the hardened container or an external VM boundary for high-risk adversarial workloads.
