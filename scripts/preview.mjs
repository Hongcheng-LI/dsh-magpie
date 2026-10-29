#!/usr/bin/env node
// Render the panel to a static HTML file using live Magpie data.
//
//   node scripts/preview.mjs [outFile]
//
// Why this exists: the panel lives inside DSH, and the only other way to look
// at a layout change is to restart the app and click. This loads the real
// `dsh/client.js` with a stub DOM, feeds it the same payloads the host half
// serves, and writes a single self-contained page you can open in any browser.
//
// Requires Magpie to be reachable (MAGPIE_URL, default http://127.0.0.1:3425).
// If it is not, the script still writes the panel's offline state, which is
// worth looking at too.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outFile = path.resolve(process.argv[2] || path.join(root, "preview.html"));
const BASE = (process.env.MAGPIE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** Load client.js in a sandbox and hand back its debug exports. */
async function loadClient() {
  const source = await readFile(path.join(root, "dsh", "client.js"), "utf8");
  const g = { dataset: {}, style: {}, textContent: "" };
  const makeEl = () => ({
    dataset: {},
    style: {},
    textContent: "",
    className: "",
    id: "",
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    contains: () => false,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  });

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    Math,
    JSON,
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      getElementById: () => null,
      createElement: makeEl,
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  };
  sandbox.window = {
    __ModuleLoader__: {
      load(ref) {
        sandbox.__ref = ref;
      },
    },
    localStorage: sandbox.localStorage,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.js" });

  const ref = sandbox.__ref;
  if (!ref || typeof ref.factory !== "function") throw new Error("client.js did not register with __ModuleLoader__");
  const mod = ref.factory(() => ({}));
  if (typeof mod.__debug_panelHtml !== "function") throw new Error("client.js has no __debug_panelHtml export");
  return mod;
}

const mod = await loadClient();

let payload;
let usage;
let offline = null;
try {
  const [quotas, usageBody] = await Promise.all([
    getJson(`${BASE}/v1/magpie/quotas`),
    getJson(`${BASE}/v1/magpie/usage`),
  ]);
  payload = {
    ok: true,
    base: BASE,
    version: quotas.version || quotas.build || null,
    fetchedAt: new Date().toISOString(),
    providers: Array.isArray(quotas.data) ? quotas.data : [],
  };
  usage = { ok: true, period: "30d", ...usageBody };
} catch (err) {
  offline = err.message;
  payload = { ok: false, message: offline, base: BASE, providers: [] };
  usage = { ok: false, message: offline, totals: {}, models: [] };
}

const state = { data: payload, usage, error: offline, loading: false, loadedAt: Date.now(), usagePeriod: "30d" };
const panelHtml = mod.__debug_panelHtml(state);

// ensureStyles() writes into a <style> node; capture whatever it injected.
const styles = [];
const realCreate = () => {
  const el = {
    dataset: {},
    style: {},
    textContent: "",
    setAttribute() {},
    appendChild() {},
  };
  Object.defineProperty(el, "textContent", {
    get: () => "",
    set: (v) => styles.push(String(v)),
  });
  return el;
};
const probeSandbox = {
  document: { getElementById: () => null, createElement: realCreate, head: { appendChild() {} }, body: { appendChild() {} } },
  window: { __ModuleLoader__: { load: () => {} }, localStorage: { getItem: () => null, setItem() {} } },
  console,
  Date,
  Math,
  JSON,
};
probeSandbox.globalThis = probeSandbox;
vm.createContext(probeSandbox);
vm.runInContext(await readFile(path.join(root, "dsh", "client.js"), "utf8"), probeSandbox, { filename: "client.js" });
if (typeof mod.__debug_styles === "function") mod.__debug_styles();

const css = styles.sort((a, b) => b.length - a.length)[0] || "";

const page = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<title>dsh-magpie preview</title>
<style>
  body { margin: 0; padding: 24px; background: #0d1117; color: #e6edf3;
         font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
  .frame { position: relative; }
  .label { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #8b949e; margin: 0 0 8px; }
  .light { background: #f6f8fa; color: #1f2328; padding: 24px; border-radius: 12px; }
</style>
<body>
<div class="wrap">
  <div class="frame"><p class="label">composer pill</p>
    <div style="display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:8px 12px;font-size:14px;">
      <span>+</span><span>输入消息…</span>
      <span style="margin-left:24px;display:inline-flex;align-items:center;gap:6px;"><span style="color:#e3b341;">●</span>用量/额度</span>
    </div>
  </div>
</div>
<div class="wrap" style="margin-top:20px;">
  <div class="frame"><p class="label">panel</p>
    <div style="position:relative;transform:none;">${panelHtml}</div>
  </div>
</div>
<style>${css}</style>
<script>
  // The panel is absolutely positioned for the real app; inside this page it
  // should sit in flow so a screenshot captures all of it.
  const p = document.getElementById("magpie-quota-panel");
  if (p) { p.style.position = "static"; p.style.maxHeight = "none"; p.style.width = "880px"; }
</script>
</body></html>
`;

await writeFile(outFile, page, "utf8");
console.log(`preview → ${outFile}${offline ? `  (offline: ${offline})` : `  (${payload.providers.length} providers)`}`);
