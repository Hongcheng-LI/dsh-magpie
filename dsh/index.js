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

// Magpie's usage log aggregate (/v1/magpie/usage): 30-day totals plus per-model
// breakdown. The client shows the per-model numbers on the left half of the card
// (用量) and the quota list on the right (额度).
function normalizeUsage(body) {
  const models = Array.isArray(body && body.models) ? body.models : [];
  const rows = models.map((m) => {
    const nums = pickNumbers(m, USAGE_NUM_KEYS);
    return Object.assign(
      {
        id: m && m.id,
        provider: m && m.provider,
        model: m && m.model,
        name: (m && m.name) || (m && m.model) || "?",
        sub: m && m.sub,
      },
      nums
    );
  });
  rows.sort((a, b) => (b.cost - a.cost) || (b.credits - a.credits) || (b.calls - a.calls));
  return {
    period: (body && body.period) || "30d",
    since: body && body.since,
    totals: pickNumbers(body, USAGE_NUM_KEYS),
    models: rows,
    agents: Array.isArray(body && body.agents)
      ? body.agents.map((a) => Object.assign({ id: a && a.id, name: a && a.name, icon: a && a.icon }, pickNumbers(a, USAGE_NUM_KEYS)))
      : [],
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

  // ---- usage half (per-model 用量) ------------------------------------------
  // Magpie's aggregate endpoint understands period=7d/30d/all but not 1d, and it
  // cannot split the per-model list by day. For the 当天 tab the host therefore
  // takes today's bucket from the daily series (top-line numbers) and re-aggregates
  // today's requests (paginated rows, newest first) into a per-model list.
  const USAGE_PERIODS = new Set(["1d", "7d", "30d", "all"]);
  const usageCaches = new Map(); // period -> { at, payload }

  function localMidnightMs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function localDayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function rowTs(r) {
    const n = Date.parse(String((r && r.t) || ""));
    return isFinite(n) ? n : NaN;
  }

  async function loadUsageDay() {
    const midMs = localMidnightMs();
    const key = localDayKey(midMs);
    const agg = await fetchJson(ctx, base + "/v1/magpie/usage");
    const series = Array.isArray(agg && agg.series) ? agg.series : [];
    let bucket = null;
    for (const s of series) {
      const ts = Date.parse(String((s && s.time) || ""));
      if (isFinite(ts) ? ts >= midMs : String((s && s.time) || "").slice(0, 10) === key) bucket = s;
    }
    const totals = pickNumbers(bucket || {}, USAGE_NUM_KEYS);
    // Per-model: walk the requests log (newest first) with `offset` — Magpie ignores
    // `page`. Timestamps come back in mixed shapes ("…+08:00" and "…Z") and rows are
    // only roughly time-ordered, so keep draining pages while a page still holds any
    // of today's rows and stop once one page has none.
    const byKey = new Map();
    // Overall time budget: on chatty days this can walk a hundred+ pages serially;
    // cap the work so the panel never waits for the full crawl.
    const deadline = Date.now() + 10_000;
    for (let off = 0; off < 20000; off += 100) {
      if (off > 0 && Date.now() > deadline) break;
      const res = await fetchJson(ctx, base + "/v1/magpie/usage/requests?period=7d&offset=" + off + "&pageSize=100");
      const rows = res && Array.isArray(res.rows) ? res.rows : [];
      if (!rows.length) break;
      let anyInDay = false;
      for (const r of rows) {
        const ts = rowTs(r);
        const inDay = isFinite(ts) ? ts >= midMs : String((r && r.t) || "").slice(0, 10) >= key;
        if (!inDay) continue;
        anyInDay = true;
        const id = String((r && (r.req || r.model)) || "?");
        let m = byKey.get(id);
        if (!m) {
          m = {
            id,
            provider: r.provider,
            model: r.model,
            name: r.model || "?",
            sub: [r.providerName, r.host].filter(Boolean).join(" · "),
            calls: 0, errors: 0, input: 0, output: 0, cache_read: 0, cost: 0, unpriced: 0,
          };
          byKey.set(id, m);
        }
        m.calls += 1;
        if (Number(r.status) >= 400) m.errors += 1;
        m.input += Number(r.in) || 0;
        m.output += Number(r.out) || 0;
        m.cache_read += Number(r.cache_read) || 0;
        if (r.priced === false) m.unpriced += 1;
        else m.cost += Number(r.cost) || 0;
      }
      if (!anyInDay) break;
    }
    const models = Array.from(byKey.values()).sort((a, b) => (b.cost - a.cost) || (b.calls - a.calls));
    return { period: "1d", since: key, totals, models, agents: [] };
  }

  async function loadUsage(force, period) {
    const p = USAGE_PERIODS.has(period) ? period : "30d";
    const now = Date.now();
    const hit = usageCaches.get(p);
    if (!force && hit && now - hit.at < USAGE_TTL_MS) return hit.payload;
    const norm = p === "1d"
      ? await loadUsageDay()
      : normalizeUsage(await fetchJson(ctx, base + "/v1/magpie/usage?period=" + encodeURIComponent(p)));
    const payload = Object.assign({ ok: true, base, fetchedAt: new Date().toISOString() }, norm);
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
