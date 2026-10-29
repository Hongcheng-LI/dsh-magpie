// Offline tests for the browser half (`dsh/client.js`).
//
// The bundle only knows two browser globals — `window.__ModuleLoader__` (how it
// announces itself) and `document` (where it mounts the panel). Stubbing those
// two lets us render the panel HTML in plain Node and assert on what the user
// would see, with no DSH, no browser and no Magpie running.
//
// Run with:  node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "dsh", "client.js");

function fakeElement() {
  const el = {
    tagName: "div",
    style: {},
    id: "",
    className: "",
    textContent: "",
    innerHTML: "",
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false;
    },
    closest() {
      return null;
    },
  };
  created.push(el);
  return el;
}

const created = [];

const loaded = [];

async function loadClient() {
  globalThis.document = {
    getElementById() {
      return null;
    },
    createElement: fakeElement,
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    __ModuleLoader__: {
      load(config) {
        loaded.push(config);
      },
    },
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  await import(pathToFileURL(CLIENT).href);
  const config = loaded.find((c) => c && c.id === "dsh-magpie");
  assert.ok(config, "client bundle registers itself as dsh-magpie via __ModuleLoader__.load");
  const mod = config.factory(() => ({}));
  return mod;
}

const mod = await loadClient();

const provider = (over) =>
  Object.assign(
    {
      provider: "test",
      name: "Test",
      kind: "subscription",
      plan: "Free plan",
      user: "u",
      windows: [
        { name: "5 hours", used: 71.4, pct: 71.4, display: "110.88 / 800", resetsAt: new Date(Date.now() + 3600e3).toISOString() },
      ],
      worstPct: 71,
      balance: null,
      error: null,
      readAt: new Date().toISOString(),
    },
    over,
  );

const dataState = (providers) => ({
  data: {
    version: "0.1.1900",
    base: "http://127.0.0.1:3425",
    fetchedAt: new Date().toISOString(),
    providers,
  },
  usage: { ok: true, period: "30d", totals: { calls: 10, cost: 1.5 }, models: [] },
  error: null,
  loading: false,
  loadedAt: Date.now(),
  usagePeriod: "30d",
});

test("debug hooks are exposed", () => {
  assert.equal(typeof mod.__debug_panelHtml, "function");
  assert.equal(typeof mod.__debug_styles, "function");
  assert.equal(typeof mod.apply, "function");
  assert.deepEqual(mod.inject, ["slots", "timer"]);
});

test("error state says it cannot reach Magpie, and still renders the quota column", () => {
  const html = mod.__debug_panelHtml({
    data: null,
    usage: { ok: false, message: "ECONNREFUSED" },
    error: "connect ECONNREFUSED 127.0.0.1:3425",
    loading: false,
    loadedAt: Date.now(),
    usagePeriod: "30d",
  });
  assert.match(html, /连不上 Magpie/);
  assert.match(html, /mq-colhead/);
  assert.match(html, /额度/);
});

test("empty state explains that no account is connected", () => {
  const html = mod.__debug_panelHtml(dataState([]));
  assert.match(html, /没有已接入的账号/);
});

test("subscription windows are labelled in Chinese and values sit on the right", () => {
  const html = mod.__debug_panelHtml(
    dataState([
      provider({
        provider: "minimax-cn",
        name: "MiniMax (China)",
        plan: "Pro",
        windows: [
          { name: "4 hours", used: 26.5, pct: 26.5, display: "1.2M / 4.5M", resetsAt: new Date(Date.now() + 86400e3).toISOString() },
          { name: "7 days", used: 69.9, pct: 69.9, display: "7.0M / 10M", resetsAt: new Date(Date.now() + 3 * 86400e3).toISOString() },
        ],
        worstPct: 70,
        resets: {
          count: 7,
          fiveHour: 7,
          until: "2026-11-22",
          each: Array.from({ length: 7 }, (_, i) => ({
            window: "fiveHour",
            until: i < 4 ? "2026-11-22T10:00:00+08:00" : "2026-12-22T10:00:00+08:00",
          })),
        },
      }),
    ]),
  );
  assert.match(html, /class="mq-pname"[^>]*>MiniMax \(China\)</);
  assert.match(html, /4 小时用量上限/);
  assert.match(html, /每周限额/);
  assert.match(html, /剩余 73%/); // 100 - 26.5 -> 73
  assert.match(html, /剩余 30%/); // 100 - 69.9 = 30.1 -> rounds to 30
  assert.match(html, /重置卡/);
  assert.match(html, /×4/);
});

test("windows are ordered short → long even when Magpie lists them the other way round", () => {
  // Zhipu GLM hands over "MCP · Month" before "5 hours"; the panel must not mirror that.
  const html = mod.__debug_panelHtml(
    dataState([
      provider({
        provider: "zhipu",
        name: "Zhipu GLM",
        plan: "GML Coding Plan",
        windows: [
          { name: "MCP · Month", used: 10, pct: 10, display: "", resetsAt: "2026-11-22T10:18:04+08:00" },
          { name: "5 hours", used: 0, pct: 0, display: "", resetsAt: "2026-10-29T14:00:00+08:00" },
        ],
        worstPct: 10,
      }),
    ]),
  );
  const five = html.indexOf("5 小时用量上限");
  const month = html.indexOf("MCP 月度限额");
  assert.ok(five >= 0 && month >= 0, "both window labels should render");
  assert.ok(five < month, "5 小时用量上限 must come before MCP 月度限额");
});

test("money balance accounts show the amount, credit and API-key accounts degrade gracefully", () => {
  const html = mod.__debug_panelHtml(
    dataState([
      provider({ provider: "deepseek", name: "DeepSeek", kind: "balance", windows: [], balance: "¥9.87", worstPct: 0 }),
      provider({ provider: "opencode-zen-free", name: "Zen Free", plan: "Credits", windows: [], balance: null, worstPct: 0 }),
    ]),
  );
  assert.match(html, /余额/);
  assert.match(html, /¥9\.87/);
  assert.match(html, /未提供余额/);
});

test("a failed probe renders 读取失败 plus the reason", () => {
  const html = mod.__debug_panelHtml(
    dataState([
      provider({
        provider: "workbuddy",
        name: "WorkBuddy",
        windows: [],
        worstPct: 0,
        error: "401 Unauthorized: invalid api key",
      }),
    ]),
  );
  assert.match(html, /读取失败/);
  assert.match(html, /mq-wfail/);
});

test("free accounts are tagged from the plan field and from the known-id list", () => {
  const html = mod.__debug_panelHtml(
    dataState([
      provider({ provider: "workbuddy", name: "WorkBuddy", plan: "Free plan", windows: [] }),
      provider({ provider: "trae-cn", name: "Trae CN", plan: "Credits", windows: [] }),
      provider({ provider: "opencode-zen-free", name: "OpenCode Zen Free", plan: "Credits", windows: [] }),
    ]),
  );
  const tags = html.match(/（免费账号）/g) || [];
  assert.equal(tags.length, 2, "WorkBuddy (plan) + Trae (known list); the name that already says Free is not re-tagged");
});

test("styles pin the 16/14px type scale the user asked for", () => {
  created.length = 0;
  mod.__debug_styles();
  const css = created.map((el) => String(el.textContent || "")).sort((a, b) => b.length - a.length)[0] || "";
  assert.ok(css.length > 500, "ensureStyles injected a stylesheet");
  assert.match(css, /\.mq-pname\{[^}]*font-size:16px;font-weight:700/);
  assert.match(css, /\.mq-ptag\{[^}]*font-size:16px;font-weight:400/);
  assert.match(css, /#magpie-quota-panel/);
});
