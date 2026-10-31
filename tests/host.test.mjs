// Tests for the host half (`dsh/index.js`).
//
// The host half is a plain ESM module with two exported entry points —
// `isTrustedRequest()` and `apply(ctx)` — so it can be exercised in Node with a
// stubbed kernel: a fake `webServer` that records the routes, a no-op timer, and
// a stubbed global `fetch` standing in for the local Magpie gateway. No Magpie,
// no DSH, no network.
//
// Run with:  node --test tests/
import test from "node:test";
import assert from "node:assert/strict";

process.env.MAGPIE_URL = "http://magpie.test";
const { apply, isTrustedRequest, name, inject } = await import("../dsh/index.js");

const ORIGINAL_FETCH = globalThis.fetch;
let fetchLog = [];
let canned = () => ({});

function stubFetch() {
  fetchLog = [];
  globalThis.fetch = async (url) => {
    fetchLog.push(String(url));
    const body = canned(String(url));
    if (body instanceof Error) throw body;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };
}

function makeKernel() {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    inject(deps, fn) {
      assert.deepEqual(deps, ["webServer"]);
      fn({ webServer: { register: (def) => routes.set(def.path, def) } });
    },
    timer: {
      interval: () => () => {},
      timeout: () => () => {},
    },
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return () => {};
    },
    // No subprocess service: the fetch path is what tests drive.
  };
  apply(ctx);
  return { routes, disposers };
}

function call(route, { url = "/x", method = "GET", headers = { host: "127.0.0.1:3000" } } = {}) {
  const req = { method, url, headers };
  let status = null;
  let payload = null;
  const res = {
    writeHead(s) {
      status = s;
    },
    end(text) {
      payload = JSON.parse(text);
    },
  };
  return route.handler(req, res).then(() => ({ status, body: payload }));
}

test.beforeEach(stubFetch);
test.after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("module announces the intended identity and dependencies", () => {
  assert.equal(name, "dsh-magpie-quota");
  assert.deepEqual(inject, ["subprocess", "timer"]);
});

test("isTrustedRequest admits direct local hosts only", () => {
  const ok = (headers) => isTrustedRequest({ headers });

  assert.equal(ok({ host: "127.0.0.1:3000" }), true);
  assert.equal(ok({ host: "localhost:8080" }), true);
  assert.equal(ok({ host: "[::1]:8080" }), true);
  assert.equal(ok({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), true);

  assert.equal(ok({}), false, "no host header");
  assert.equal(ok({ host: "example.com" }), false, "remote host");
  assert.equal(ok({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }), false);
  assert.equal(ok({ host: "127.0.0.1:3000", origin: "http://evil.example" }), false, "origin mismatch");
});

test("GET /magpie/quotas normalizes windows, balances, resets and errors", async () => {
  canned = (url) => {
    if (url === "http://magpie.test/") return { version: "0.1.1900" };
    if (url === "http://magpie.test/v1/magpie/quotas") {
      return {
        data: [
          {
            provider: "zhipu",
            name: "Zhipu GLM",
            kind: "plan",
            plan: "lite",
            windows: [{ name: "MCP · Month", used: 10, display: "10 / 100" }],
            resets: {
              count: 2,
              each: [
                { window: "fiveHour", until: "2026-11-22T10:00:00+08:00" },
                { window: "fiveHour", until: "2026-12-22T10:00:00+08:00" },
              ],
            },
          },
          {
            provider: "deepseek",
            name: "DeepSeek",
            kind: "balance",
            windows: [],
            balance: "¥9.87",
          },
          {
            provider: "workbuddy",
            name: "WorkBuddy",
            kind: "subscription",
            windows: [{ name: "Credits", amount: 48.5, limit: 800, display: "48.5 / 800" }],
            error: "401 Unauthorized",
          },
        ],
      };
    }
    throw new Error("unexpected url " + url);
  };

  const { routes } = makeKernel();
  const route = routes.get("/magpie/quotas");
  assert.ok(route, "quotas route registered");

  const { status, body } = await call(route, { url: "/magpie/quotas?force=1" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.base, "http://magpie.test");
  assert.equal(body.version, "0.1.1900");
  assert.equal(body.providers.length, 3);

  const [zhipu, deepseek, workbuddy] = body.providers;

  assert.equal(zhipu.pct === undefined, true, "pct lives on windows, not the provider");
  assert.equal(zhipu.windows[0].pct, 10);
  assert.equal(zhipu.worstPct, 10);
  assert.equal(zhipu.resets.each.length, 2);

  assert.equal(deepseek.balance, "¥9.87");
  assert.equal(deepseek.windows.length, 0);

  // amount/limit is converted to a percent when `used` is absent, and clamped.
  assert.equal(workbuddy.windows[0].pct, 6.0625);
  assert.equal(workbuddy.worstPct, 6);
  assert.equal(workbuddy.error, "401 Unauthorized");
});

test("GET /magpie/usage passes the period through and normalizes totals", async () => {
  canned = (url) => {
    if (url === "http://magpie.test/v1/magpie/usage/requests?period=7d") {
      return {
        period: "7d",
        total: 5,
        calls: 5,
        cost: 1.25,
        input: 100,
        output: 50,
        cache_read: 10,
        by: {
          provider: [{ id: "zhipu", name: "Zhipu GLM", calls: 5, cost: 1.25, input: 100, output: 50, cache_read: 10 }],
          agent: [{ id: "dsh", name: "dsh", calls: 5, cost: 1.25 }],
        },
      };
    }
    throw new Error("unexpected url " + url);
  };

  const { routes } = makeKernel();
  const { status, body } = await call(routes.get("/magpie/usage"), { url: "/magpie/usage?period=7d" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.period, "7d");
  assert.equal(body.totals.calls, 5);
  assert.equal(body.totals.cost, 1.25);
  assert.equal(body.totals.retried, 0, "missing numeric keys default to 0");
  assert.equal(body.groups.length, 1);
  assert.equal(body.groups[0].name, "Zhipu GLM");
  assert.equal(body.groups[0].cost, 1.25);
  assert.equal(body.agents[0].id, "dsh");
  assert.ok(fetchLog.some((u) => u.endsWith("/v1/magpie/usage/requests?period=7d")), "requested the 7d request-log aggregate");
});

test("an unknown period falls back to 30d instead of shouting at Magpie", async () => {
  canned = (url) => {
    if (url.startsWith("http://magpie.test/v1/magpie/usage/requests?period=")) return { period: "30d", calls: 1 };
    throw new Error("unexpected url " + url);
  };

  const { routes } = makeKernel();
  const { body } = await call(routes.get("/magpie/usage"), { url: "/magpie/usage?period=99d" });
  assert.equal(body.period, "30d");
  assert.ok(fetchLog.includes("http://magpie.test/v1/magpie/usage/requests?period=30d"));
});

test("a dead gateway degrades to ok:false with a reason rather than throwing", async () => {
  canned = () => new Error("connect ECONNREFUSED 127.0.0.1:3425");

  const { routes } = makeKernel();
  const quotas = await call(routes.get("/magpie/quotas"), { url: "/magpie/quotas?force=1" });
  assert.equal(quotas.status, 200);
  assert.equal(quotas.body.ok, false);
  assert.match(String(quotas.body.message), /ECONNREFUSED/);
  assert.deepEqual(quotas.body.providers, []);

  const usage = await call(routes.get("/magpie/usage"), { url: "/magpie/usage?force=1" });
  assert.equal(usage.body.ok, false);
  assert.deepEqual(usage.body.models, []);
});

test("cross-site and non-GET requests are refused before any fetch happens", async () => {
  canned = () => {
    throw new Error("must not be reached");
  };

  const { routes } = makeKernel();
  const route = routes.get("/magpie/quotas");

  const cross = await call(route, { url: "/magpie/quotas", headers: { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" } });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.kind, "forbidden");

  const post = await call(route, { url: "/magpie/quotas", method: "POST" });
  assert.equal(post.status, 405);

  assert.equal(fetchLog.length, 0, "no network traffic for refused requests");
});
