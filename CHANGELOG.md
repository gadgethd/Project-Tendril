# Changelog

## 1.1.0 - 2026-08-27

- **Compact snapshot mode** — reduces token usage by up to 90% via depth limiting, text inlining, and empty container drops while preserving interactive elements.
- **Snapshot diff mode** — tracks page changes between snapshots with +/- line diffs and summary counts.
- **Structured data extraction** — parse JSON-LD, OpenGraph, microdata, prices, dates, and deduplicated authors from any page.
- **Session health checks** — process liveness, memory usage, uptime, and page count.
- **Activity logging** — bounded ring buffer tracking all browser actions with timestamps.
- **Cookie import/export** — save and restore clearance cookies across sessions.
- **Session export/import** — full state snapshot (cookies, localStorage, URL, viewport) for session persistence.
- **Request interception** — agent-controlled URL pattern blocking and header modification.
- **Search rate-limit awareness** — per-provider tracking with structured retry info and health monitoring.
- **Crawl follow-up queries** — iterative research with parent job linking.
- **Research refinement** — follow-up queries on existing research jobs.
- **Form filling helper** — browser_act with action=fill_form for multi-field form completion.
- **Download to workspace** — browser_files with action=save to move downloads to accessible paths.
- **Multi-tab context** — browser_page with action=list_with_content for page summaries.
- **Screenshot saveOnly mode** — skip base64 return when only file output is needed.
- **MCP tool wiring** — all new features accessible via expanded tool schemas with optional parameters.

## 1.0.0 - 2026-08-21

- Initial open-source release.
- Local process-isolated Chromium sessions with ephemeral and named profiles.
- Native MCP, REST quick actions, authenticated raw CDP, and dashboard interfaces.
- Semantic snapshots and ref-based actions, extraction, captures, diagnostics, storage, files, and emulation.
- Browser-driven search, evidence gathering, and bounded robots-aware crawling.
- Human-in-the-loop challenge detection, headed-session focus, clearance waiting, and profile retention without automated CAPTCHA bypass.
- Public-network egress policy, path controls, secret redaction, Docker packaging, and real-Chromium integration tests.
