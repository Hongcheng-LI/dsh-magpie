# Architecture

dsh-magpie is two files that talk to each other through one DSH route.

```
┌─────────────────────────── DSH window (browser) ───────────────────────────┐
│                                                                            │
│  composer slot: conversation.input.right                                   │
│  ┌────────────────────────────────────┐                                    │
│  │  ● 用量/额度                       │  ← pill (client.js)                │
│  └────────────────────────────────────┘                                    │
│              │ click                                                        │
│              ▼                                                              │
│  ┌──────────────────────── panel ────────────────────────┐                 │
│  │ 当前用量 (当天/7天/30天/全部)  │  额度 (按 provider)   │                 │
│  └───────────────────────────────────────────────────────┘                 │
│              │ fetch('/magpie/quotas')  fetch('/magpie/usage?period=…')     │
└──────────────┼─────────────────────────────────────────────────────────────┘
               │  same origin, so no CORS, no token
┌──────────────▼────────────── DSH host (Node) ──────────────────────────────┐
│  dsh/index.js                                                              │
│    ctx.webServer.register  GET /magpie/quotas                              │
│                            GET /magpie/usage                               │
│         │                                                                  │
│         │ isTrustedRequest()  → 403 on cross-site                          │
│         │ method === 'GET'    → 405 otherwise                              │
│         ▼                                                                  │
│    fetch(MAGPIE_URL + '/v1/magpie/quotas')                                 │
│    fetch(MAGPIE_URL + '/v1/magpie/usage?period=…')                         │
│         │  normalize → { provider, name, kind, windows[pct], balance, … }   │
│         ▼  cached 15 s (the panel polls every 60 s)                        │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ 127.0.0.1:3425
┌──────────────▼─────────────────────────────────────────────────────────────┐
│  Magpie — local gateway holding every upstream credential                  │
│    /v1/magpie/quotas          subscriptions, plans, prepaid balances       │
│    /v1/magpie/usage           totals + per-model series                    │
│    /v1/magpie/usage/requests  raw request rows (paged by offset)           │
└────────────────────────────────────────────────────────────────────────────┘
```

## Why the host half exists at all

The browser could call `http://127.0.0.1:3425` directly, but Magpie sends no
CORS headers, so every request from the DSH page would be blocked. Routing
through `ctx.webServer` puts the call on the same origin as the page: no CORS
preflight, no token, nothing to configure. It also gives one place to say no —
`isTrustedRequest()` refuses `sec-fetch-site: cross-site` and any non-local
`Host`, so a page in another tab cannot use the plugin as a proxy to Magpie.

## Data shape as it crosses the boundary

`/v1/magpie/quotas` answers with one entry per provider:

| field | example | meaning |
| --- | --- | --- |
| `provider` | `minimax-cn` | stable id, what `freeTag()` and sorting key off |
| `kind` | `subscription` \| `plan` \| `balance` | decides how the row is drawn |
| `windows[]` | `{ name: "4 hours", used, limit, display, resetsAt }` | rolling limits |
| `pct` (on a window) | `73` | used %, computed from `used` or `amount/limit` |
| `balance` | `¥9.87` | prepaid money, `kind: balance` only |
| `resets.each[]` | `{ window, until }` | one entry per reset card |
| `error` | `401 Unauthorized` | upstream refused; shown as 读取失败 |

The host normalizes before caching so the client never has to know Magpie's
raw vocabulary, and the 15-second cache means a 60-second poll costs four
upstream reads an hour, not sixty.

## The 1d period

`/v1/magpie/usage` returns a fixed 30-day aggregate. For 当天 the host fetches
`/v1/magpie/usage/requests` and sums the current calendar day itself:

- pages with **`offset`**, not `page` — Magpie ignores `page` and hands back the
  same first hundred rows forever (a bug this plugin hit and documented);
- stops when a whole page holds nothing from today, not at the first older
  row — the rows are not strictly time-ordered and mix `+08:00` with `Z`;
- gives up after 10 s and returns what it has, so a slow gateway cannot hang the
  panel.
