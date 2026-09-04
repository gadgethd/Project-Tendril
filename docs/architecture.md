# Architecture

## Request flow

`BrowserManager` owns session metadata and one `TendrilSession` per browser process. The shared search service owns provider health, bounded caches, in-flight requests, and retained research jobs; the crawl service owns crawl jobs. MCP, REST, the dashboard, and Chromium CDP forwarding refer to the same runtime state.

For each session Tendril:

1. Creates an ephemeral directory or locks a named persistent profile.
2. Starts a dedicated loopback forward proxy with that session's network policy.
3. Launches the configured backend with a fresh storage directory, the proxy, and a random loopback CDP port. Obscura is the default; Chromium is the headed and compatibility fallback.
4. Connects Playwright to the backend through CDP for high-level control.
5. Registers bounded console, network, download, page, crash, and dialog observers.
6. Deletes the profile on close when the session is ephemeral.

The process-per-session model costs more memory than browser-context pooling, but it contains crashes and avoids shared cookie, cache, worker, and process state between unrelated agents.

## Agent representation

Snapshots walk visible DOM semantics in every reachable frame, derive accessible roles/names, and attach short refs only to interactive targets. A ref maps to a page, frame, page URL, snapshot, and generated selector. Navigation and browser actions invalidate the map. This makes stale actions fail explicitly instead of selecting a different element.

Reader extraction runs Mozilla Readability against serialized HTML and converts the result to Markdown. Search and research return structured source URLs, titles, snippets, and evidence chunks; Tendril does not summarize with a model.

Search provider requests run without a browser through the shared policy-aware text transport. Each redirect is validated and its destination address is pinned. Four provider requests can run concurrently, independently of browser capacity, with a per-provider limit of two and singleflight deduplication for identical queries and controls. Google pagination stops at the requested result limit and keeps previous pages if a later page fails. Query-specific empty or irrelevant results do not trip the provider outage circuit.

The same bounded transport powers session `fetchText` through its egress proxy. Fetching text does not invalidate page refs; navigation invalidates only the affected page. Total deadlines cover DNS, redirect chains, retry delays, and response body streaming. Both wire bytes and decompressed bytes are bounded.

## Interfaces

- Stdio MCP starts an embedded runtime and writes protocol data only to stdout. Logs use stderr.
- Streamable HTTP MCP is stateless at the transport layer while sharing the local browser manager.
- REST quick actions acquire reference-counted leases on disposable sessions unless a `sessionId` is supplied. Concurrent actions for one named profile share the session, and its final lease release performs cleanup.
- CDP traffic is forwarded byte-for-byte to Chromium sessions after HTTP/WebSocket authentication. Obscura creates a new isolated context per CDP WebSocket, so Tendril does not expose a misleading second connection as the session debugger.
- The dashboard is static HTML and uses the same REST calls as external clients.

## Failure model

Session-independent work such as extraction, search parsing, and crawl queue handling is disposable. A failed page or provider produces a typed error or partial crawl result. Browser crashes affect only one session. Shutdown kills the complete browser process group, closes proxy connections, and removes ephemeral state.

Search and research retain completed results on deadline expiry and mark partial responses. Explicit cancellation propagates to shared upstream work only after the last caller leaves; cancelling one caller cannot cancel another caller's search. Evidence waits for browser capacity within the operation deadline. Tool errors distinguish invalid arguments, transport failures, timeouts, disconnected browsers, and internal errors, with concrete recovery guidance. REST maps transport failures to 502, timeouts to 504, unavailable browsers to 503, and internal failures to 500.

The TypeScript layer remains a thin MCP, REST, policy, and lifecycle control plane. The default rendering and JavaScript hot path runs in Obscura's Rust engine; local benchmarks did not show a reason to rewrite the orchestration layer in Rust. See [Obscura backend](obscura-backend.md) for compatibility and benchmark details.

Completed crawl jobs expire after 30 minutes even when no later API request arrives. Retained markdown is bounded per page and per job, and result pagination prevents a single status response from copying the complete job history.
