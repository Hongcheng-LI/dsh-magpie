// dsh/index.js — dsh-magpie-quota host half (bundle form).
//
// Responsibility: read the local Magpie AI gateway's quota API and expose it to
// the DSH web UI on a same-origin route.
//
//   GET /magpie/quotas[?force=1]  ->  { ok, base, fetchedAt, version, providers: [...] }
//
// Why a host route: Magpie's API (127.0.0.1:3425) sends no CORS headers, so the
// browser half cannot fetch it directly from the DSH page origin. The host half
// fetches it server-side (Node fetch, falling back to curl via subprocess) and
// re-serves the JSON on the DSH web server, which is same-origin for the client.
//
// Zero configuration: the Magpie port defaults to 3425 (override with the
// MAGPIE_URL environment variable, e.g. MAGPIE_URL=http://127.0.0.1:4000).

export const name = "dsh-magpie-quota";
export const inject = ["subprocess", "timer"];

const DEFAULT_BASE = "http://127.0.0.1:3425";
const CACHE_TTL_MS = 15_000;
const USAGE_TTL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const WARM_INTERVAL_MS = 60_000;

function resolveBase() {
  let env = {};
  try {
    if (typeof process !== "undefined" && process.env) env = process.env;
  } catch (e) {}
  const raw = env.MAGPIE_URL || env.MAGPIE_BASE_URL || "";
  const base = String(raw || DEFAULT_BASE).trim() || DEFAULT_BASE;
  return base.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- fetch layer

async function fetchJsonViaNativeFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error("HTTP " + res.status + ": " + text.slice(0, 200));
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonViaCurl(ctx, url) {
  const subprocess = ctx.subprocess;
  if (!subprocess) throw new Error("subprocess service unavailable");
  let curlPath = null;
  try {
    curlPath = await subprocess.resolveExecutable("curl");
  } catch (e) {
    throw new Error("cannot locate curl: " + ((e && e.message) || e));
  }
  const handle = subprocess.spawn({
    argv: [
      curlPath, "-sS",
      "--noproxy", "*",
      "--max-time", String(Math.floor(REQUEST_TIMEOUT_MS / 1000)),
      "-H", "Accept: application/json",
      "-w", "\n%{http_code}",
      url,
    ],
    cwd: "/",
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 4 * 1024 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: REQUEST_TIMEOUT_MS + 4000,
  });
  const outcome = await handle.done;
  const stdout = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0) : "";
  const text = String(stdout || "");
  const nl = text.lastIndexOf("\n");
  if (nl < 0) throw new Error("curl returned no body: " + text.slice(0, 200));
  const body = text.slice(0, nl);
  const status = text.slice(nl + 1).trim();
  if (status !== "" && status !== "200") {
    const stderr = handle.collected && handle.collected.stderr ? String(handle.collected.stderr.readFrom(0) || "") : "";
    throw new Error("HTTP " + status + (stderr ? " " + stderr.slice(0, 200) : body.slice(0, 200)));
  }
  return JSON.parse(body);
}

async function fetchJson(ctx, url) {
  let firstError = null;
  try {
    if (typeof fetch === "function") return await fetchJsonViaNativeFetch(url);
  } catch (e) {
    firstError = e;
  }
  try {
    return await fetchJsonViaCurl(ctx, url);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const prev = firstError ? String((firstError && firstError.message) || firstError) : "";
    throw new Error(msg + (prev ? " (native fetch: " + prev + ")" : ""));
  }
}

// ------------------------------------------------------------ request trust

function isDirectHost(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (/^[0-9a-f:]*:[0-9a-f:]*$/i.test(hostname)) return true; // IPv6 literal
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);          // IPv4 literal
}

export function isTrustedRequest(req) {
  const host = req.headers && req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (!isDirectHost(hostUrl.hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- payload

// Magpie window shape (observed):
//   { name, used (% 0-100), remaining, resetsAt, display, amount, limit, unit,
//     runsOutAt, runsOut, holdsWhy }
// We pass entries through but add a computed `pct` (used percent 0-100) so the
// client never has to guess between percent-based and amount/limit-based data.
function normalizeWindow(w) {
  if (!w || typeof w !== "object") return w;
  let pct = null;
  if (typeof w.used === "number" && isFinite(w.used)) {
    pct = w.used;
  } else if (typeof w.amount === "number" && typeof w.limit === "number" && w.limit > 0) {
    pct = (w.amount / w.limit) * 100;
  }
  if (pct !== null) {
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
  }
  const out = Object.assign({}, w, { pct });
  return out;
}

function normalizeQuotaEntry(entry) {
  const windows = Array.isArray(entry && entry.windows) ? entry.windows.map(normalizeWindow) : [];
  let worst = 0;
  for (const w of windows) {
    if (w && typeof w.pct === "number" && w.pct > worst) worst = w.pct;
  }
  // `balance` is Magpie's pre-formatted money/prepaid amount (e.g. "¥9.99") for
  // providers whose adapter probes a balance endpoint (kind === "balance").
  // It is a plain string: currency and scale are Magpie's, so we pass it as-is.
  const balance = entry && entry.balance != null ? String(entry.balance) : null;
  const out = {
    provider: entry && entry.provider,
    name: (entry && entry.name) || (entry && entry.provider) || "?",
    kind: entry && entry.kind,
    plan: entry && entry.plan,
    user: entry && entry.user,
    windows,
    worstPct: Math.round(worst),
    balance,
    readAt: entry && entry.readAt,
    // Magpie reports a failed balance/quota probe here (e.g. "401 Unauthorized: …").
    // Passing it through lets the panel say *why* a row is empty instead of guessing.
    error: entry && entry.error ? String(entry.error) : null,
    renew: entry && entry.renew,
    until: entry && entry.until,
  };
  // Spend / reset allowances Magpie attaches to some plans (GLM "剩余 N 次重置").
  // Keep the per-card breakdown (`each`: one entry per card with the window it restores
  // and its expiry) — the panel groups them into "5 小时重置卡 ×7 · 11-22 到期".
  if (entry && entry.resets && typeof entry.resets === "object") {
    const r = entry.resets;
    out.resets = {
      count: typeof r.count === "number" ? r.count : null,
      until: r.until || null,
      fiveHour: typeof r.fiveHour === "number" ? r.fiveHour : null,
      byWindow: !!r.byWindow,
      each: Array.isArray(r.each)
        ? r.each.slice(0, 50).map((c) => ({
            window: c && c.window ? String(c.window) : null,
            until: c && c.until ? String(c.until) : null,
          }))
        : null,
    };
  }
  return out;
}

// -------------------------------------------------------------------- apply

function pickNumbers(src, keys) {
  const out = {};
  for (const k of keys) {
    const v = src && src[k];
    out[k] = typeof v === "number" && isFinite(v) ? v : 0;
  }
  return out;
}

const USAGE_NUM_KEYS = [
  "calls", "errors", "retried", "input", "output", "cache_read", "cache_write",
  "reasoning", "cost", "credits", "credited", "unpriced", "timed",
];

// Magpie's request-log aggregate (/v1/magpie/usage/requests): this is the SAME view
// Magpie's 用量 dashboard renders. Unlike /v1/magpie/usage (gateway-reported calls
// only, ~236/day), the request log rolls up EVERY logged call — including the
// "local session" (session-unknown) calls the harness itself makes — so its totals
// line up with the numbers a user sees in Magpie. The response carries the whole
// period's aggregate at the top level plus ready-made `by.provider` / `by.agent` /
// `by.model` groupings, so no client-side pagination or re-aggregation is needed.
function normalizeUsage(body) {
  const by = (body && body.by) || {};
  const groups = Array.isArray(by.provider)
    ? by.provider.map((p) =>
        Object.assign(
          { id: p && p.id, name: (p && p.name) || (p && p.id) || "?", icon: p && p.icon },
          pickNumbers(p, USAGE_NUM_KEYS)
        )
      )
    : [];
  groups.sort((a, b) => (b.cost - a.cost) || (b.credits - a.credits) || (b.calls - a.calls));
  const agents = Array.isArray(by.agent)
    ? by.agent.map((a) => Object.assign({ id: a && a.id, name: a && a.name, icon: a && a.icon }, pickNumbers(a, USAGE_NUM_KEYS)))
    : [];
  return {
    period: (body && body.period) || "30d",
    since: body && body.since,
    totals: pickNumbers(body, USAGE_NUM_KEYS),
    groups,
    agents,
    models: [], // kept for payload-shape compatibility; the list is now `groups`
  };
}

export function apply(ctx) {
  const base = resolveBase();
  let cache = null; // { at: number, payload: object }
  let version = null;
  let firstLogged = false;
  let requestedOnce = false;

  async function load(force) {
    const now = Date.now();
    if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.payload;

    const roots = await Promise.allSettled([
      fetchJson(ctx, base + "/"),
    ]);
    for (const r of roots) {
      if (r.status === "fulfilled" && r.value && typeof r.value === "object") {
        if (r.value.version) version = r.value.version;
      }
    }

    const body = await fetchJson(ctx, base + "/v1/magpie/quotas");
    const list = body && Array.isArray(body.data) ? body.data : [];
    const payload = {
      ok: true,
      base,
      version,
      fetchedAt: new Date().toISOString(),
      providers: list.map(normalizeQuotaEntry),
    };
    cache = { at: Date.now(), payload };
    if (!firstLogged) {
      firstLogged = true;
      console.log("[dsh-magpie-quota] first fetch ok: " + payload.providers.length + " providers @ " + base);
    }
    return payload;
  }

  async function loadSafe(force) {
    try {
      return await load(force);
    } catch (e) {
      const msg = String((e && e.message) || e);
      return { ok: false, kind: "offline", base, message: msg, fetchedAt: new Date().toISOString(), providers: [] };
    }
  }

  // Lazy warm: only keep the cache fresh once the client has asked at least once.
  const warm = async () => {
    if (!requestedOnce) return;
    try { await load(false); } catch (e) {}
  };
  const disposeTimer = ctx.timer.interval(warm, WARM_INTERVAL_MS);
  ctx.timer.timeout(warm, 150);

  // ---- usage half (按供应商用量) --------------------------------------------
  // Every tab talks to Magpie's own REQUEST-LOG aggregate endpoint
  // (/v1/magpie/usage/requests) with the same period param its 用量 dashboard uses,
  // so our numbers match that page exactly. That endpoint returns the whole period's
  // aggregate at the top level plus `by.provider`/`by.agent`/`by.model` groupings, so
  // no manual pagination or re-aggregation is needed. The 当天 tab maps to Magpie's
  // native "today" period. (The older /v1/magpie/usage endpoint only counts
  // gateway-reported calls and omitted local-session traffic, so it under-counted by
  // ~2–5×; it is no longer used.)
  const USAGE_PERIODS = new Set(["1d", "7d", "30d", "all"]);
  const MAGPIE_PERIOD = { "1d": "today", "7d": "7d", "30d": "30d", all: "all" };
  const usageCaches = new Map(); // period -> { at, payload }

  async function loadUsage(force, period) {
    const p = USAGE_PERIODS.has(period) ? period : "30d";
    const now = Date.now();
    const hit = usageCaches.get(p);
    if (!force && hit && now - hit.at < USAGE_TTL_MS) return hit.payload;
    const norm = normalizeUsage(
      await fetchJson(ctx, base + "/v1/magpie/usage/requests?period=" + encodeURIComponent(MAGPIE_PERIOD[p]))
    );
    const payload = Object.assign({ ok: true, base, fetchedAt: new Date().toISOString() }, norm, { period: p });
    usageCaches.set(p, { at: Date.now(), payload });
    return payload;
  }

  async function loadUsageSafe(force, period) {
    try {
      return await loadUsage(force, period);
    } catch (e) {
      return {
        ok: false,
        kind: "offline",
        base,
        message: String((e && e.message) || e),
        fetchedAt: new Date().toISOString(),
        period: null,
        totals: pickNumbers(null, USAGE_NUM_KEYS),
        models: [],
        agents: [],
      };
    }
  }

  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (scope) => {
      const register = (path, loader) =>
        scope.webServer.register({
          name: "dsh-magpie-quota" + (path === "/magpie/quotas" ? "" : "-usage"),
          kind: "exact",
          path,
          handler: async (req, res) => {
            const send = (status, body) => {
              res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
              res.end(JSON.stringify(body));
            };
            try {
              if (!isTrustedRequest(req)) {
                send(403, { ok: false, kind: "forbidden", message: "request refused: same-origin direct-host only" });
                return;
              }
              if (req.method !== "GET") {
                send(405, { ok: false, kind: "other", message: "method not allowed" });
                return;
              }
              const params = new URL(req.url, "http://localhost").searchParams;
              requestedOnce = true;
              send(200, await loader(params.get("force") === "1", params.get("period")));
            } catch (e) {
              send(200, { ok: false, kind: "other", message: String((e && e.message) || e) });
            }
          },
        });
      try {
        register("/magpie/quotas", loadSafe);
        register("/magpie/usage", loadUsageSafe);
        console.log("[dsh-magpie-quota] routes GET /magpie/quotas + /magpie/usage registered (base " + base + ")");
      } catch (e) {
        console.error("[dsh-magpie-quota] route registration failed: " + ((e && e.stack) || e));
      }
    });
  }

  ctx.effect(() => {
    return () => {
      try { disposeTimer(); } catch (e) {}
      cache = null;
    };
  });
}
