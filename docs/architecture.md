# Architecture

## Request flow

Tendril has one stateful component: `BrowserManager`. It owns session metadata and one `TendrilSession` per Chromium process. MCP, REST, the dashboard, and CDP forwarding all refer to the same session identifiers.

For each session Tendril:

1. Creates an ephemeral directory or locks a named persistent profile.
2. Starts a dedicated loopback forward proxy with that session's network policy.
3. Launches Chromium with a fresh user-data directory, the proxy, site isolation, background networking disabled, and a random loopback CDP port.
4. Connects Playwright to Chromium through CDP for reliable high-level control.
5. Registers bounded console, network, download, page, crash, and dialog observers.
6. Deletes the profile on close when the session is ephemeral.

The process-per-session model costs more memory than browser-context pooling, but it contains crashes and avoids shared cookie, cache, worker, and process state between unrelated agents.

## Agent representation

Snapshots walk visible DOM semantics in every reachable frame, derive accessible roles/names, and attach short refs only to interactive targets. A ref maps to a page, frame, page URL, snapshot, and generated selector. Navigation and browser actions invalidate the map. This makes stale actions fail explicitly instead of selecting a different element.

Reader extraction runs Mozilla Readability against serialized HTML and converts the result to Markdown. Search and research return structured source URLs, titles, snippets, and evidence chunks; Tendril does not summarize with a model.

## Interfaces

- Stdio MCP starts an embedded runtime and writes protocol data only to stdout. Logs use stderr.
- Streamable HTTP MCP is stateless at the transport layer while sharing the local browser manager.
- REST quick actions create disposable sessions unless a `sessionId` is supplied.
- CDP traffic is forwarded byte-for-byte to the selected browser process after HTTP/WebSocket authentication.
- The dashboard is static HTML and uses the same REST calls as external clients.

## Failure model

Session-independent work such as extraction, search parsing, and crawl queue handling is disposable. A failed page or provider produces a typed error or partial crawl result. Chromium crashes affect only one session. Shutdown kills the complete Chromium process group, closes proxy connections, and removes ephemeral state.
