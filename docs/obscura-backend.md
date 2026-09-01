# Obscura backend decision

## Decision

Obscura is Tendril's default browser backend. Chromium remains an explicit compatibility backend.

This puts the performance-sensitive path in Rust without rewriting Tendril's MCP and REST control plane. Obscura owns HTTP, cookie storage, DOM construction, V8 execution, layout, paint, screenshots, and PDF generation. Tendril retains session policy, its egress proxy, semantic snapshots and refs, extraction, crawling, transports, and the dashboard.

## Compatibility adapter

Obscura supports Playwright over CDP, but it is an independent engine rather than a Chromium build. Tendril has two backend-specific adaptations:

- `page.setContent()` waits for Chromium lifecycle events, so Tendril injects fixture/content HTML with `document.open()`, `document.write()`, and `document.close()` on Obscura.
- Playwright locator actionability checks assume Chromium layout details. Tendril resolves its already-validated semantic ref and performs the equivalent DOM-native input, change, pointer, keyboard, focus, selection, check, and scroll operations on Obscura.

The normal stale-ref rule is unchanged: every action invalidates refs, and an agent must take a fresh snapshot before the next action.

## Known backend differences

| Capability | Obscura (default) | Chromium fallback |
| --- | --- | --- |
| Headless navigation, JavaScript, cookies, forms | Yes | Yes |
| Semantic snapshots, extraction, search, crawl | Yes | Yes |
| Multiple pages | Yes | Yes |
| Screenshots and PDF | Yes; independent Rust renderer | Yes; Chrome renderer |
| Stealth transport and tracker blocking | Yes, enabled by default | No Tendril patches |
| Visible/headed human handoff | No | Yes |
| Long-tail Web APIs, native media, service workers | Evolving/incomplete | Chrome behavior |
| Exact Chrome CSS/compositor fidelity | No | Yes |
| Geolocation, offline, permissions, media/timezone emulation | Fails fast with `UNSUPPORTED_OPERATION` | Yes |
| Raw CDP URL for an existing Tendril session | No; Obscura isolates every CDP WebSocket | Yes |
| Selectable/tagged PDF text | No; raster-backed | Browser-dependent |

Use `TENDRIL_BROWSER_BACKEND=chromium` for a site or workflow that needs a missing capability. This is a per-runtime setting; sessions in one runtime use the configured backend.

## Security boundary

Every Obscura process receives Tendril's loopback egress proxy. Tendril passes `--allow-private-network` to the engine so its own `allowedHosts` policy can permit a narrow private destination; all HTTP and HTTPS traffic still traverses the proxy, which resolves and validates every destination. High-level navigation continues to reject non-HTTP(S) schemes.

Obscura receives `--allow-file-access` because Tendril's upload API canonicalizes paths and restricts them to configured workspace roots. As with Chromium, an authenticated in-process CDP controller is privileged. Tendril does not expose Obscura's CDP endpoint through the public gateway because a second Obscura WebSocket creates a different browser context and would not control the advertised session.

Obscura stealth mode is a privacy and fingerprint-consistency feature. It does not grant authorization, solve challenges, or change Tendril's prohibition on access-control bypass.

## Measured result

Run the deterministic comparison with:

```bash
TENDRIL_OBSCURA_PATH=/path/to/obscura npm run benchmark:backends -- --runs=7
```

On the Linux development host used for the migration, seven isolated-session runs against the same local HTML fixture produced these medians:

| Metric | Obscura 0.2.1 | Chromium | Ratio |
| --- | ---: | ---: | ---: |
| Session startup | 68.4 ms | 389.7 ms | 5.7× faster |
| Local navigation | 12.3 ms | 28.5 ms | 2.3× faster |
| Tendril semantic snapshot | 30.6 ms | 53.0 ms | 1.7× faster |
| Startup + navigation + snapshot | 111.0 ms | 470.0 ms | 4.2× faster |
| Browser process RSS | 47.9 MiB | 244.3 MiB | 5.1× lower |

These are local measurements, not universal claims. Run the benchmark on the deployment hardware, and separately test real target sites for rendering and Web API fidelity.

## Why the control plane remains TypeScript

The benchmark shows the material gain comes from replacing the browser engine. Porting Tendril's control plane to Rust would not make Obscura's Rust/V8/network/render path more native. It would require replacing the mature MCP SDK integration, Playwright CDP adapter, Readability/Turndown extraction, HTTP service, tests, and public TypeScript API before producing a like-for-like runtime.

A future Rust control plane remains possible, but it should start only after profiling shows control-plane CPU or memory is a meaningful part of production workloads. The benchmark script gives that work a reproducible baseline instead of treating a language rewrite as a proxy for performance.
