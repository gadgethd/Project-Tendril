# Security model

Tendril assumes every page and every MCP tool argument can be hostile. It provides guardrails, not a complete VM boundary.

## Network

Every Chromium session uses a dedicated forward proxy. The proxy resolves hostnames itself and connects to the vetted IP, preventing a second browser-side DNS resolution. By default it rejects loopback, private, link-local, multicast, reserved, carrier-grade NAT, and cloud metadata destinations for both HTTP and HTTPS CONNECT tunnels. Redirects and subresource hosts create new proxy requests and are checked again.

DNS A and AAAA lookups use a per-operation cancellable c-ares resolver so shutdown and crawl cancellation can bound and join outstanding resolution. Except for numeric addresses and the special `localhost` namespace, this does not consult operating-system NSS/hosts-file aliases or search domains; configure authoritative DNS or use an explicit numeric/allowed host when those local resolution features would otherwise be required.

Explicit `allowedHosts` entries may reach private addresses and override the private-network check. `blockedHosts` wins over the allowlist. `file:`, `data:`, and other navigation protocols are rejected by the high-level API. Chromium extensions, background networking, and non-proxied WebRTC UDP are disabled.

Raw CDP remains powerful. Tendril issues a short-lived HMAC capability scoped to one session instead of placing the master token in CDP URLs. An authorized CDP client controls its browser process and should be treated like an authorized shell inside that browser profile.

## Profiles and credentials

Tendril never attaches to the user's normal Chrome profile. Ephemeral sessions are the default. Named profiles are opt-in, use portable non-device basenames, are stored separately, and are locked to one live session. A page opened in an authenticated profile can act with that profile's authority, so profiles should be narrow and task-specific.

Profile locks fail closed after a crash or other unclean exit, and profile deletion acquires the same exclusive lease before removing data. If startup reports a stale or unverifiable lock, first verify that no Tendril process owns that profile, then explicitly remove the reported `.profile-locks/<name>.lock` file. Tendril does not reclaim these files automatically: a portable read-then-unlink sequence could delete a replacement lock published by another process.

On Windows, Tendril records Chromium's launch-time process creation identity and verifies that identity before any process-tree force termination. If CIM enumeration, helper termination, or descendant exit cannot be verified, shutdown fails closed and retains the named-profile lease; investigate the reported local process/lock state instead of automatically deleting the lock.

Only health, the dashboard, and its root redirect are public. HTTP MCP, REST, metrics, OpenAPI, and CDP authenticate every peer, including loopback and private networks. Generated master tokens are atomically stored with owner-only permissions and owner checks on POSIX; on Windows their privacy inherits the configured `dataDir` ACL, so operators using custom or shared paths must restrict that ACL or provide `TENDRIL_TOKEN` through a secret manager. Configured tokens must be at least 32 bytes. Authentication failures and CDP connection attempts have bounded per-peer rate limits. Host-header checks reduce DNS-rebinding exposure and wildcard listeners accept only numeric private-network authorities; Tendril strips its bearer token before forwarding authorized CDP traffic to Chromium. Stdio MCP does not need a token because the client owns its child process.

## Filesystem

Uploads are restricted to configured workspace roots after resolving symlinks and canonical paths. Downloads remain in Chromium's session-scoped storage. The Docker deployment runs non-root with a read-only root filesystem, only the `SYS_CHROOT` capability retained for Chromium's sandbox, tmpfs runtime storage, and the supplied Chromium-compatible seccomp profile when invoked as documented. Docker's `no-new-privileges` option is intentionally incompatible with Chromium's setuid sandbox and must not be added.

## Prompt injection

Accessibility labels, hidden text, search snippets, and documents are untrusted content. Tendril returns them in structured fields with `untrustedContent: true` and warns on common instruction-override and exfiltration phrases. Detection is heuristic and cannot make arbitrary web content safe. MCP hosts should maintain an instruction/data boundary and require approval for sensitive actions.

## Logs and telemetry

Tendril has no telemetry. Structured logs redact credentials embedded in URLs and sensitive query keys. Cookies, authorization headers, response bodies, and page content are not logged by default.

## Challenge handling

Tendril detects common challenge pages (Cloudflare, Turnstile, reCAPTCHA, hCaptcha, and others) and supports two resolution paths:

- **Human-in-the-loop** (default): pause for a human to complete the challenge in a headed session. Legitimately issued clearance cookies remain in that session or named profile for their normal server-defined lifetime.
- **Automated resolution** (opt-in): when `challengeAutoSolve` / `TENDRIL_CHALLENGE_AUTO_SOLVE` is enabled, Tendril attempts local heuristic resolution for supported challenge types. This does not contact external solving services, synthesize challenge tokens, or apply stealth patches.

Both paths process everything locally. Tendril does not outsource solving, copy clearance between devices, or apply stealth patches.

## Out of scope

Tendril does not bypass paywalls, access controls, robots.txt in crawl/research mode, or browser security warnings. Native mode relies on Chromium's sandbox and the operating system. Use the hardened container or an external VM boundary for high-risk adversarial workloads.
