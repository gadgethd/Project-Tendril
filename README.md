# Project Tendril

<p align="center">
  <img src="https://raw.githubusercontent.com/gadgethd/Project-Tendril/main/project-tendril_picture.png" alt="Project Tendril visual: luminous digital tendrils connecting isolated browser windows" width="100%">
</p>

[![CI](https://github.com/gadgethd/Project-Tendril/actions/workflows/ci.yml/badge.svg)](https://github.com/gadgethd/Project-Tendril/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gadgethd/Project-Tendril/actions/workflows/codeql.yml/badge.svg)](https://github.com/gadgethd/Project-Tendril/actions/workflows/codeql.yml)
[![GitHub release](https://img.shields.io/github/v/release/gadgethd/Project-Tendril?display_name=tag&sort=semver)](https://github.com/gadgethd/Project-Tendril/releases)
[![License](https://img.shields.io/github/license/gadgethd/Project-Tendril)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-7c3aed)](https://modelcontextprotocol.io/)

**A local-first Chromium browser and web-research runtime built for AI agents.**

Project Tendril gives MCP clients and autonomous agents a real, isolated Chromium process with token-efficient semantic snapshots, ref-based browser actions, rendered-page extraction, search, research, crawling, screenshots, PDFs, diagnostics, and authenticated Chrome DevTools Protocol access.

It runs locally, has no embedded LLM, sends no telemetry, and never attaches to your everyday browser profile.

> [!IMPORTANT]
> Project Tendril does not disguise automation, evade paywalls, solve CAPTCHAs, or manufacture clearance cookies. It detects common challenge pages and provides a headed, human-in-the-loop handoff for legitimate access; see [Challenge handling](#challenge-handling).

## Contents

- [Why Project Tendril?](#why-project-tendril)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Connect an MCP client](#connect-an-mcp-client)
- [MCP tools](#mcp-tools)
- [REST and CDP](#rest-and-cdp)
- [Search, research, and crawling](#search-research-and-crawling)
- [Challenge handling](#challenge-handling)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Docker](#docker)
- [Deployment and recovery](docs/deployment.md)
- [Release process](docs/releasing.md)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Project status and roadmap](#project-status-and-roadmap)
- [Contributing](#contributing)

## Why Project Tendril?

Most browser integrations give an agent either raw screenshots or a large, unstable DOM. Project Tendril adds an agent-oriented layer over Chromium:

- **Real browser compatibility** — JavaScript, cookies, forms, downloads, frames, PDFs, and modern rendering all run in Chromium.
- **Compact semantic state** — accessibility-informed snapshots expose roles, names, values, and short-lived element refs without returning an entire page source.
- **Deterministic actions** — agents act on refs from the newest snapshot; stale refs fail instead of silently selecting the wrong element.
- **Useful web evidence** — search, rendered-page extraction, and multi-source research return structured URLs and untrusted evidence without hiding an LLM in the browser layer.
- **Process isolation** — each Tendril session owns a Chromium process, profile directory, CDP endpoint, and network proxy.
- **Multiple interfaces** — use stdio MCP, Streamable HTTP MCP, authenticated REST, raw CDP, the CLI, or the local dashboard.
- **Local control** — profiles, cookies, downloads, browser processes, and logs remain on the machine running Tendril.

Project Tendril is inspired by the architectural ideas in Cloudflare's [Kitesurf announcement](https://blog.cloudflare.com/kitesurf/): fresh sessions, centralized outbound access, structured browser representations, bounded failure, and disposable workers. Project Tendril is an independent implementation, uses local Chromium, and contains no Cloudflare source code.

## Features

### Browser automation

- Dedicated Chromium process and user-data directory per session.
- Ephemeral sessions by default; opt-in named profiles for durable logins.
- Multiple pages per session with open, list, select, and close operations.
- Navigation history, reload, configurable load states, and bounded waits.
- Click, double-click, hover, focus, fill, type, select, check, press, scroll, drag, and upload actions.
- JavaScript dialogs, cookies, storage, permissions, geolocation, offline mode, viewport, timezone, locale, media preferences, headers, and HTTP credentials.
- Full-page, viewport, and element screenshots plus PDF output.
- Bounded console events, request/response metadata, response bodies, downloads, and page-scoped JavaScript evaluation.

### Agent-oriented page understanding

- Interactive, full, reader, and differential semantic snapshots.
- Short element refs tied to a specific page, frame, URL, and snapshot.
- Snapshot pagination and output limits for predictable context use.
- Mozilla Readability extraction and HTML-to-Markdown conversion.
- Structured links, metadata, forms, and tables.
- Explicit `untrustedContent: true` markers and heuristic prompt-injection warnings.

### Web discovery

- Chromium-driven search with Bing, DuckDuckGo, Google, and optional SearXNG adapters.
- Automatic provider fallback when a provider fails or challenges the browser.
- Multi-query research with URL deduplication and source-attributed evidence chunks.
- Bounded, cancellable, robots-aware crawling with same-origin and depth controls.

### Interfaces and operations

- MCP over stdio for simple local client ownership.
- Stateless Streamable HTTP MCP for a shared long-running service.
- Authenticated REST quick actions and session APIs.
- Authenticated raw CDP WebSockets for Playwright, Puppeteer, DevTools, and CDP clients.
- Local observation and control dashboard.
- Runtime diagnostics, structured logging, profile management, Docker packaging, and CI.

## How it works

```mermaid
flowchart LR
    A[AI agent or MCP client] -->|stdio MCP| M[MCP server]
    A -->|Bearer-authenticated HTTP| H[HTTP service]
    C[CDP client] -->|Authenticated WebSocket| H
    U[Local operator] -->|Dashboard| H

    M --> B[BrowserManager]
    H --> B
    B --> S1[Tendril session]
    B --> S2[Tendril session]

    S1 --> P1[Per-session egress proxy]
    S1 --> R1[Dedicated Chromium process]
    S2 --> P2[Per-session egress proxy]
    S2 --> R2[Dedicated Chromium process]

    P1 --> W[Public web]
    P2 --> W
```

For every session, Project Tendril:

1. Creates an ephemeral directory or locks an explicitly named profile.
2. Starts a loopback forward proxy with that session's network policy.
3. Launches a separate Chromium process with a random loopback CDP port.
4. Connects Playwright over CDP for high-level browser control.
5. Registers bounded browser, console, network, download, crash, page, and dialog observers.
6. Terminates the complete process group and deletes ephemeral state when the session closes.

This process-per-session model uses more memory than browser-context pooling, but prevents unrelated agents from sharing cookies, cache, service workers, extension state, or a browser crash boundary.

See [Architecture](docs/architecture.md) for implementation detail.

## Requirements

- **Node.js 22.19 or newer**
- **Chromium, Google Chrome, or Playwright-managed Chromium**
- A non-root user with a working Chromium sandbox

Linux is the fully tested v1.0 platform. Project Tendril includes Chromium discovery for Windows and macOS, and CI exercises all three operating systems, but Linux remains the recommended deployment target.

## Quick start

### Install from source

```bash
git clone https://github.com/gadgethd/Project-Tendril.git
cd Project-Tendril
npm ci
npm run build
npm link
tendril doctor
```

If no supported browser is installed:

```bash
tendril install-browser
```

Run the local HTTP service, dashboard, MCP endpoint, and CDP gateway:

```bash
tendril serve
```

Or run only a stdio MCP server:

```bash
tendril mcp
```

Use `--headed` when a visible browser is required:

```bash
tendril serve --headed
```

`tendril serve` prints a dashboard URL containing the local bearer token in the URL fragment. The dashboard moves the token to session storage; URL fragments are not sent as part of HTTP requests.

### Run without linking

```bash
npm ci
npm run build
node dist/cli.js doctor
node dist/cli.js mcp
```

## Connect an MCP client

### Local stdio

Stdio is the simplest and safest configuration. The MCP client starts Project Tendril as a child process and owns its lifetime:

```json
{
  "mcpServers": {
    "project-tendril": {
      "command": "tendril",
      "args": ["mcp"]
    }
  }
}
```

For a source checkout without `npm link`:

```json
{
  "mcpServers": {
    "project-tendril": {
      "command": "node",
      "args": [
        "/absolute/path/to/Project-Tendril/dist/cli.js",
        "mcp"
      ]
    }
  }
}
```

To permit a person to complete an interactive login or challenge, add `--headed` to the arguments.

### Streamable HTTP

Start the shared service:

```bash
TENDRIL_TOKEN="replace-with-a-long-random-token" tendril serve
```

Then configure an MCP client for:

- URL: `http://127.0.0.1:3210/mcp`
- Header: `Authorization: Bearer replace-with-a-long-random-token`

If `TENDRIL_TOKEN` is not set, Project Tendril creates a random token and stores it at:

- Linux: `~/.local/share/project-tendril/http-token`
- Other platforms: the operating system's equivalent user data directory

### Recommended agent workflow

1. Create an ephemeral session with `browser_session`.
2. Navigate with `browser_navigate`.
3. Take a fresh `browser_snapshot`.
4. Use refs from that snapshot with `browser_act`.
5. Take another snapshot after navigation or DOM-changing actions.
6. Close the session when the task is complete.

Never cache element refs across navigation. Refs are intentionally invalidated when their page state is no longer current.

## MCP tools

Project Tendril 1.0 exposes 18 tools:

| Tool | Purpose |
| --- | --- |
| `browser_session` | Create, list, inspect, reset, and close isolated sessions |
| `browser_page` | List, open, select, and close pages |
| `browser_navigate` | Go to a URL, reload, or move backward and forward |
| `browser_snapshot` | Return interactive, full, reader, or diff semantic snapshots |
| `browser_act` | Perform ref-based pointer, keyboard, form, drag, scroll, and upload actions |
| `browser_wait` | Wait for text, a selector, URL, load state, or bounded delay |
| `browser_extract` | Extract HTML, Markdown, text, links, metadata, forms, or tables |
| `browser_search` | Search the web through Chromium with provider fallback |
| `browser_research` | Run multiple searches and gather deduplicated, source-attributed evidence |
| `browser_crawl` | Start, inspect, retrieve, or cancel a bounded crawl |
| `browser_capture` | Capture PNG/JPEG screenshots or PDFs |
| `browser_evaluate` | Evaluate explicit page-scoped JavaScript |
| `browser_inspect` | Read bounded console, network, download, or response-body diagnostics |
| `browser_storage` | Inspect, set, or clear cookies and origin storage |
| `browser_configure` | Configure viewport, headers, location, permissions, media, and connectivity |
| `browser_files` | Inspect session-scoped downloads |
| `browser_dialog` | Inspect, accept, or dismiss JavaScript dialogs |
| `browser_challenge` | Detect a challenge, hand it to a human, and wait for legitimate clearance |

The MCP resource `tendril://status` reports runtime version and active-session status.

## REST and CDP

All endpoints except `/health`, `/dashboard`, and `/openapi.json` require the bearer token. The service binds to loopback by default.

### Extract Markdown from a rendered page

```bash
TOKEN="$(tr -d '\n' < ~/.local/share/project-tendril/http-token)"

curl --fail-with-body --silent --show-error \
  http://127.0.0.1:3210/v1/markdown \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://example.com"}'
```

Other quick actions include:

- `POST /v1/snapshot`
- `POST /v1/content`
- `POST /v1/accessibility-tree`
- `POST /v1/links`
- `POST /v1/screenshot`
- `POST /v1/pdf`
- `POST /v1/search`
- `POST /v1/research`
- `POST /v1/crawl`

### Create a durable browser session

```bash
curl --fail-with-body --silent --show-error \
  http://127.0.0.1:3210/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"profile":"documentation"}'
```

The session response includes a browser-level `cdpUrl`. Its query token supports CDP clients that cannot supply custom WebSocket headers.

### Connect Playwright over CDP

```javascript
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.TENDRIL_CDP_URL);
const context = browser.contexts()[0];
const pages = context.pages();

console.log(await pages[0].title());
```

Treat possession of a CDP URL like possession of the bearer token: an authenticated CDP client has complete control of that Tendril browser session.

The running service exposes a compact OpenAPI document at [http://127.0.0.1:3210/openapi.json](http://127.0.0.1:3210/openapi.json).

## Search, research, and crawling

`browser_search` renders provider result pages in Chromium and returns normalized titles, URLs, snippets, ranks, and provider names. The default order is:

1. Bing
2. DuckDuckGo
3. Google

Configure a self-hosted SearXNG instance by setting `searxngUrl` and adding `searxng` to `searchProviders`.

`browser_research` accepts up to ten queries, deduplicates result URLs, visits a bounded number of sources, and returns evidence chunks with their source URL, title, heading, and originating query. It does not generate a summary; the calling agent remains responsible for analysis and citation.

`browser_crawl` creates an asynchronous job with:

- A maximum of 100 pages.
- A maximum depth of 5.
- Same-origin restriction enabled by default.
- `robots.txt` compliance enabled by default.
- Cancellation, status, partial results, and per-page errors.

Search providers and websites may rate-limit automated access. Project Tendril reports the failure or tries the next configured search provider; it does not apply stealth patches by default.

## Challenge handling

When `browser_challenge` detects Cloudflare, Turnstile, reCAPTCHA, hCaptcha, DuckDuckGo, Google, or an unknown challenge, Project Tendril pauses automation for a human handoff. It does not attempt to solve or bypass challenges automatically.

A human completes the challenge in a headed Chromium window:

1. Start Project Tendril with `--headed`, or create the session with `headless: false`.
2. Call `browser_challenge` with `action: "inspect"`.
3. Call it with `action: "handoff"`; Project Tendril focuses the exact challenged page.
4. A human completes the challenge in Chromium.
5. Call it with `action: "wait"`; the tool returns when the challenge disappears.
6. Resume automation in the same session.

### General guidance

- Use a narrowly scoped named profile when a legitimate login or clearance cookie must survive a restart. Project Tendril does not copy clearance between profiles or machines.
- For automated tests, prefer the challenge provider's official testing keys and test modes.

## Configuration

Copy the example:

```bash
cp tendril.config.example.json tendril.config.json
```

Configuration precedence is:

1. Built-in defaults
2. `tendril.config.json`
3. `TENDRIL_*` environment variables
4. CLI flags

### Important options

| JSON key | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `host` | `TENDRIL_HOST` | `127.0.0.1` | HTTP bind host |
| `port` | `TENDRIL_PORT` | `3210` | HTTP listen port |
| `headless` | `TENDRIL_HEADLESS` | `true` | Launch Chromium without a visible window |
| `executablePath` | `TENDRIL_EXECUTABLE_PATH` | auto-detected | Chromium or Chrome executable |
| `maxSessions` | `TENDRIL_MAX_SESSIONS` | `4` | Maximum concurrent Chromium processes |
| `sessionIdleMs` | `TENDRIL_SESSION_IDLE_MS` | `600000` | Idle-session lifetime |
| `blockPrivateNetworks` | `TENDRIL_BLOCK_PRIVATE_NETWORKS` | `true` | Block loopback, private, link-local, metadata, and reserved destinations |
| `allowedHosts` | `TENDRIL_ALLOWED_HOSTS` | `[]` | Comma-separated host allowlist |
| `blockedHosts` | `TENDRIL_BLOCKED_HOSTS` | `[]` | Comma-separated host blocklist |
| `workspaceRoots` | `TENDRIL_WORKSPACE_ROOTS` | current directory | Permitted upload roots |
| `searchProviders` | `TENDRIL_SEARCH_PROVIDERS` | `bing,duckduckgo,google` | Ordered search adapters |
| `searxngUrl` | `TENDRIL_SEARXNG_URL` | unset | Optional self-hosted SearXNG URL |
| `dataDir` | `TENDRIL_DATA_DIR` | platform data directory | Named profiles and HTTP token |
| `runtimeDir` | `TENDRIL_RUNTIME_DIR` | platform runtime directory | Ephemeral session state |
| `token` | `TENDRIL_TOKEN` | generated | HTTP, MCP, metrics, and CDP bearer token |
| `logLevel` | `TENDRIL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

Action timeout, navigation timeout, snapshot size, and maximum response-body size can also be set in the JSON configuration. See [tendril.config.example.json](tendril.config.example.json) and [src/config.ts](src/config.ts) for the complete schema and defaults.

### Local-development access

Private and loopback destinations are blocked by default. To test a local site:

```bash
tendril mcp --allow-private-network
```

This is intentionally explicit. Prefer a narrow `allowedHosts` entry when possible.

## Security model

Project Tendril assumes every URL, page, frame, script, download, and MCP argument may be hostile.

### Network boundary

- Every session uses a dedicated HTTP/HTTPS forward proxy.
- The proxy resolves hostnames and connects only to the checked address, reducing DNS-rebinding exposure.
- Loopback, RFC1918 private networks, link-local ranges, multicast, reserved addresses, carrier-grade NAT, and cloud metadata destinations are blocked by default.
- Redirects and subresources create new proxy requests and are checked again.
- High-level navigation accepts only public HTTP(S) URLs.
- Non-proxied WebRTC UDP, QUIC, WebTransport, extensions, and Chromium background networking are disabled.

### Profile and filesystem boundary

- Project Tendril never opens the user's normal Chrome or Chromium profile.
- Named profiles are opt-in and locked to one live session.
- Upload paths are canonicalized and restricted to configured workspace roots.
- Ephemeral profiles are deleted on close.
- Chromium is refused when Project Tendril runs as root unless an explicit development override is supplied.

### Agent boundary

- Page-derived data is marked untrusted.
- Common instruction-override and exfiltration phrases produce warnings.
- Snapshot, extraction, console, network, and response-body output is bounded.
- Page JavaScript evaluation is explicit and runs inside the selected page, not the Project Tendril Node.js process.
- Challenge resolution is opt-in and local-only; no external solving services are contacted.

These controls are guardrails, not a complete virtual-machine boundary. Use the hardened container or another VM boundary for adversarial browsing. Read [Security](docs/security.md) and [SECURITY.md](SECURITY.md) before exposing Project Tendril to other machines.

## Docker

Build the image:

```bash
docker build -t project-tendril:local .
```

Run Chromium as the image's non-root `tendril` user with a read-only root filesystem and the supplied sandbox-compatible seccomp profile:

```bash
docker run --rm --init \
  --name project-tendril \
  -p 127.0.0.1:3210:3210 \
  --shm-size 1g \
  --memory 2g \
  --cpus 2 \
  --pids-limit 512 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --security-opt seccomp=seccomp_profile.json \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  -e TENDRIL_TOKEN="replace-with-a-long-random-token" \
  project-tendril:local
```

The included [seccomp profile](seccomp_profile.json) is Docker's default policy with the user-namespace operations required by Chromium's sandbox. `SYS_CHROOT` is the only retained capability and is also required by the sandbox.

Do not add Docker's `no-new-privileges` option: it prevents Chromium's setuid sandbox from starting.

Persist named profiles and the generated HTTP token:

```bash
docker volume create project-tendril-data

docker run --rm --init \
  --name project-tendril \
  -p 127.0.0.1:3210:3210 \
  --shm-size 1g \
  --memory 2g \
  --cpus 2 \
  --pids-limit 512 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --security-opt seccomp=seccomp_profile.json \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  -v project-tendril-data:/data \
  project-tendril:local
```

Do not publish port 3210 beyond loopback without an authenticated TLS reverse proxy and an explicit threat review.

## Development

```bash
git clone https://github.com/gadgethd/Project-Tendril.git
cd Project-Tendril
npm ci
npm run check
```

Useful commands:

| Command | Description |
| --- | --- |
| `npm run dev -- mcp` | Run the TypeScript source as an MCP server |
| `npm run dev -- serve` | Run the TypeScript source as the HTTP service |
| `npm run check` | Run type, lint, format, coverage, build, and package-consumer gates |
| `npm run test:package` | Pack and install the exact consumer artifact in a temporary project |
| `npm run typecheck` | Type-check without emitting files |
| `npm test` | Run the integration test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run build` | Compile ESM JavaScript and declarations into `dist/` |
| `node dist/cli.js doctor` | Check Node.js, Chromium, directories, and sandbox prerequisites |
| `npm pack --dry-run` | Inspect the release package |

The integration suite launches real Chromium and covers:

- Semantic snapshots and ref-based actions.
- MCP server discovery and browser control.
- REST quick actions and authenticated raw CDP.
- Search/crawl primitives and `robots.txt`.
- Challenge detection.
- Private-network and navigation policy.
- Screenshot generation and process cleanup.

### Repository layout

```text
Project-Tendril/
├── src/
│   ├── browser/          Chromium, sessions, snapshots, extraction, search, crawl
│   ├── security/         Network policy and per-session egress proxy
│   ├── server/           MCP, HTTP, CDP gateway, and dashboard
│   ├── cli.ts            Command-line entry point
│   ├── config.ts         Defaults, file, and environment configuration
│   └── runtime.ts        Shared service composition
├── tests/                Real-Chromium integration tests
├── docs/                 Architecture and security documentation
├── .github/              CI, security scanning, releases, and community files
├── Dockerfile
├── seccomp_profile.json
└── tendril.config.example.json
```

## Troubleshooting

### No Chromium executable found

```bash
tendril install-browser
tendril doctor
```

Or set `TENDRIL_EXECUTABLE_PATH` to a Chromium or Google Chrome executable.

### Chromium refuses to start as root

Run Project Tendril as a regular user. The browser sandbox is part of the security model. The Docker image already uses a dedicated non-root account.

### Docker reports a sandbox or namespace error

Use the documented `seccomp_profile.json`, retain only `SYS_CHROOT`, and do not set `no-new-privileges`. Run `docker build` again after changing the Dockerfile.

### A local development URL is blocked

Private destinations are denied by default. Add the exact hostname to `allowedHosts` or use `--allow-private-network` only for a trusted local-development session.

### Element ref is stale

Take a new `browser_snapshot` and use a ref from that result. Navigation and DOM-changing actions deliberately invalidate old refs.

### Search provider returns a challenge

Allow Project Tendril to try the next configured provider, configure SearXNG, or use a headed human handoff where the provider permits it. Do not retry aggressively.

## Project status and roadmap

Project Tendril 1.0 is feature-complete for local Linux deployment. The native, MCP, REST, CDP, package, and Docker paths are covered by automated integration tests.

Likely post-1.0 work:

- Broader Windows and macOS runtime validation.
- More search adapters and self-hosted discovery options.
- Trace recording and replay tooling.
- Additional snapshot compression and diff strategies.
- Optional OpenTelemetry-compatible local metrics export without hosted telemetry.
- Published npm and container-registry artifacts.

Roadmap items are not promises. Open a feature request with a concrete agent workflow and expected security boundary.

## Contributing

Contributions are welcome. Read:

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Support guide](SUPPORT.md)
- [Changelog](CHANGELOG.md)

Before opening a pull request:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Changes that add CAPTCHA solving, stealth/fingerprint evasion, telemetry, implicit access to normal browser profiles, or private-network access by default are outside the project's scope.

## License

Project Tendril is licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Project Tendril contributors.
