// dsh/client.js — magpie-quota browser half (hand-written lazy-CJS bundle).
//
// Registers one status pill in `conversation.input.right` (inside the composer
// card, next to the send button). The pill summarizes the tightest Magpie
// account; clicking it opens a panel listing every provider Magpie serves with
// per-window usage bars, consumed percent (已用) and reset countdowns.
//
// Data: same-origin GET /magpie/quotas (served by the host half, which reads
// the local Magpie gateway at 127.0.0.1:3425 — its API has no CORS headers, so
// the browser cannot call it directly).
//
// Why the panel is plain DOM appended to document.body instead of a React
// sibling: the composer area lives inside a scaled/transformed wrapper, so a
// `position: fixed` child of the slot is laid out in that wrapper's coordinate
// space and comes out half-size and pushed past the window edge. Mounting on
// <body> puts the panel in true viewport coordinates at normal scale.

window.__ModuleLoader__.load({
  id: "dsh-magpie",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    const REFRESH_INTERVAL_MS = 60_000;
    const STALE_MS = 15_000;
    // DOM ids / localStorage keys keep the historical magpie-quota-* spelling:
    // they are invisible to the plugin system, and keeping them preserves the
    // user's saved 配色 preference across the rename.
    const PANEL_ID = "magpie-quota-panel";
    const STYLE_ID = "magpie-quota-style";

    const SHORT_NAMES = {
      workbuddy: "WorkBuddy",
      "trae-cn": "Trae",
      "trae-en": "Trae",
      "minimax-cn": "MiniMax",
      "minimax-en": "MiniMax",
      zhipu: "GLM",
      "zhipu-cn": "GLM",
      codex: "Codex",
      "opencode-zen-free": "Zen",
      "opencode-zen": "Zen",
      qoder: "Qoder",
      kimi: "Kimi",
      deepseek: "DeepSeek",
    };

    function shortName(p) {
      if (!p) return "Magpie";
      if (SHORT_NAMES[p.provider]) return SHORT_NAMES[p.provider];
      const raw = String(p.name || p.provider || "?").replace(/\s*\([^)]*\)\s*/g, " ").trim();
      return raw.length > 12 ? raw.slice(0, 12) + "…" : raw;
    }

    function esc(s) {
      return String(s === undefined || s === null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function roundPct(v) {
      return typeof v === "number" && isFinite(v) ? Math.round(v) : null;
    }

    // Colours come from DSH's own design tokens (--dsw-*), so the panel follows the
    // active light/dark theme instead of hard-coding a dark palette. Fallbacks keep
    // it readable if the panel is ever rendered outside the DSH shell.
    function pctColor(pct) {
      if (typeof pct !== "number") return "var(--dsw-alias-label-caption,#8b949e)";
      if (pct >= 80) return "var(--dsw-alias-state-error-primary,#f85149)";
      if (pct >= 50) return "var(--dsw-alias-state-warn-primary,#d29922)";
      return "var(--dsw-alias-state-success-primary,#3fb950)";
    }

    // Consumed share, worded as 已用 throughout the right column. Rounded to whole
    // percents, so a tiny but non-zero usage shows "<1%" instead of a misleading 0%.
    function usedText(pct) {
      if (typeof pct !== "number" || pct <= 0) return "已用 0%";
      if (pct < 1) return "已用 <1%";
      return "已用 " + Math.min(100, Math.round(pct)) + "%";
    }

    // Leftover share, the way Codex words it ("剩余 96%"). Same rounding rules, so a
    // barely touched window never claims "剩余 100%" when something was spent.
    function leftText(pct) {
      if (typeof pct !== "number") return "—";
      const left = Math.max(0, 100 - pct);
      if (left <= 0) return "已用尽";
      if (left < 1) return "剩余 <1%";
      return "剩余 " + Math.min(100, Math.round(left)) + "%";
    }

    function fmtClock(iso) {
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      } catch (e) {
        return null;
      }
    }

    function fmtCountdown(iso) {
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        const diff = d.getTime() - Date.now();
        if (diff <= 0) return "已重置";
        const mins = Math.floor(diff / 60000);
        const days = Math.floor(mins / 1440);
        const hours = Math.floor((mins % 1440) / 60);
        const m = mins % 60;
        if (days > 0) return days + "天" + (hours > 0 ? hours + "小时" : "");
        if (hours > 0) return hours + "小时" + (m > 0 ? m + "分" : "");
        return m + "分钟";
      } catch (e) {
        return null;
      }
    }

    function fmtReset(resetsAt) {
      if (!resetsAt) return null;
      const clock = fmtClock(resetsAt);
      if (!clock) return null;
      const cd = fmtCountdown(resetsAt);
      if (cd === "已重置") return "已重置";
      try {
        const d = new Date(resetsAt);
        const sameDay = d.toDateString() === new Date().toDateString();
        const label = sameDay ? clock : d.getMonth() + 1 + "-" + d.getDate() + " " + clock;
        return "重置 " + label + (cd ? "（" + cd + "后）" : "");
      } catch (e) {
        return "重置 " + clock;
      }
    }

    // ------------------------------------------------------- usage formatting
    // Magpie's usage log reports raw token counts and a fractional cost figure, so
    // the left half of the card abbreviates tokens (16.1M) and rounds money to cents.
    function fmtTok(n) {
      if (typeof n !== "number" || !isFinite(n) || n === 0) return "0";
      const abs = Math.abs(n);
      if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
      if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
      return String(Math.round(n));
    }

    function fmtMoney(n) {
      if (typeof n !== "number" || !isFinite(n)) return "—";
      if (n === 0) return "¥0";
      if (n < 0.01) return "<¥0.01";
      return "¥" + n.toFixed(2);
    }

    function fmtInt(n) {
      if (typeof n !== "number" || !isFinite(n)) return "0";
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function fmtCredits(n) {
      if (typeof n !== "number" || !isFinite(n)) return "0";
      return (n >= 100 ? Math.round(n) : Number(n.toFixed(1))) + " 积分";
    }

    // Billing regimes are not comparable, so each row shows the unit its provider
    // actually settles in:
    //   • 积分        — subscription/plan accounts deduct credits (WorkBuddy, Trae…)
    //   • ≈¥x.xx      — plan meters nothing per token, so money is an API-list-price
    //                   estimate of what the tokens would have cost (kind plan/subscription)
    //   • ¥x.xx       — prepaid balance accounts (kind "balance", e.g. DeepSeek) really
    //                   deduct from the top-up, so the figure is actual spend
    // Returns { text, tone } where tone ∈ credits|est|real|none.
    function usageValue(m, kindOf) {
      if (m.credits > 0) return { text: fmtCredits(m.credits), tone: "credits" };
      if (m.cost > 0) {
        const kind = kindOf ? kindOf(m.provider) : null;
        if (kind === "balance") return { text: fmtMoney(m.cost), tone: "real" };
        return { text: "≈" + fmtMoney(m.cost), tone: "est" };
      }
      if (m.calls > 0) return { text: fmtInt(m.calls) + " 次", tone: "none" };
      return { text: "—", tone: "none" };
    }

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const css = [
        // Panel surface / text / border / shadow all come from DSH's theme tokens,
        // so it inherits the app palette (light or dark) instead of a fixed black.
        "#" + PANEL_ID + "{position:fixed;right:56px;bottom:96px;z-index:2147483000;",
        "width:min(880px,calc(100vw - 88px));max-height:min(78vh,760px);overflow-y:auto;",
        "box-sizing:border-box;",
        "background:var(--dsw-alias-bg-layer-1,#161b22);",
        "color:var(--dsw-alias-label-primary,#e6edf3);",
        "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12));",
        "border-radius:16px;",
        "box-shadow:var(--dsw-elevation-panel,0 16px 48px rgba(0,0,0,0.35));",
        "padding:14px 18px 12px;",
        "font-family:var(--dsw-font-family,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif);",
        "font-size:14px;line-height:1.55;",
        "scrollbar-width:thin;scrollbar-color:var(--dsh-scrollbar-thumb,rgba(127,127,127,0.4)) transparent;}",
        "#" + PANEL_ID + " *{box-sizing:border-box;}",
        "#" + PANEL_ID + " .mq-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}",
        "#" + PANEL_ID + " .mq-title{font-weight:700;font-size:16px;}",
        "#" + PANEL_ID + " .mq-ver{font-size:14px;color:var(--dsw-alias-label-caption,#8b949e);}",
        "#" + PANEL_ID + " .mq-tools{margin-left:auto;display:flex;align-items:center;gap:6px;}",
        "#" + PANEL_ID + " .mq-btn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.16));",
        "background:transparent;color:var(--dsw-alias-label-secondary,#e6edf3);border-radius:8px;font-size:14px;",
        "font-family:inherit;line-height:1.4;padding:3px 10px;cursor:pointer;white-space:nowrap;}",
        "#" + PANEL_ID + " .mq-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.1));}",
        // Usage-window tabs live in the 用量 column header; .mq-utab-on must come after
        // .mq-btn so the active state wins the cascade (same specificity).
        "#" + PANEL_ID + " .mq-utabs{margin-left:auto;display:flex;gap:4px;}",
        "#" + PANEL_ID + " .mq-utab{font-size:14px;line-height:1.4;padding:1px 9px;border-radius:999px;font-weight:400;",
        "color:var(--dsw-alias-label-caption,#8b949e);}",
        "#" + PANEL_ID + " .mq-utab-on{color:var(--dsw-alias-label-primary,#e6edf3);font-weight:600;",
        "background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.14));border-color:var(--dsw-alias-border-l2,rgba(255,255,255,0.24));}",
        "#" + PANEL_ID + " .mq-balrow{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;",
        "padding:9px 11px;margin-bottom:4px;border-radius:10px;",
        "background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.08));}",
        "#" + PANEL_ID + " .mq-balitem{display:inline-flex;align-items:baseline;gap:6px;font-size:14px;",
        "color:var(--dsw-alias-label-secondary,#8b949e);}",
        "#" + PANEL_ID + " .mq-balitem b{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;",
        "color:var(--dsw-alias-label-primary,#e6edf3);}",
        "#" + PANEL_ID + " .mq-p{padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));}",
        "#" + PANEL_ID + " .mq-p:first-of-type{border-top:none;}",
        "#" + PANEL_ID + " .mq-pname{display:flex;align-items:baseline;gap:8px;font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,#e6edf3);padding:2px 0 4px;}",
        "#" + PANEL_ID + " .mq-ptag{font-size:16px;font-weight:400;color:var(--dsw-alias-label-caption,#8b949e);}",
        "#" + PANEL_ID + " .mq-user{font-size:14px;color:var(--dsw-alias-label-caption,#8b949e);margin-top:2px;}",
        "#" + PANEL_ID + " .mq-user.mq-err{color:var(--dsw-alias-state-error-primary,#f85149);}",
        "#" + PANEL_ID + " .mq-w{display:flex;align-items:baseline;gap:14px;padding:4px 0;margin-top:0;}",
        "#" + PANEL_ID + " .mq-wname{flex:1 1 auto;min-width:0;font-size:14px;color:var(--dsw-alias-label-primary,#e6edf3);",
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "#" + PANEL_ID + " .mq-wpct{flex:0 0 auto;text-align:right;font-size:14px;",
        "font-variant-numeric:tabular-nums;font-weight:400;color:var(--dsw-alias-label-primary,#e6edf3);}",
        "#" + PANEL_ID + " .mq-wfail{color:var(--dsw-alias-state-error-primary,#f85149);}",
        "#" + PANEL_ID + " .mq-wreset{font-weight:400;color:var(--dsw-alias-label-caption,#8b949e);}",
        "#" + PANEL_ID + " .mq-empty{margin:14px 0;}",
        "#" + PANEL_ID + " .mq-err{color:var(--dsw-alias-state-error-primary,#f85149);}",
        "#" + PANEL_ID + " .mq-note{margin:4px 0 0;color:var(--dsw-alias-label-caption,#8b949e);font-size:14px;}",
        "#" + PANEL_ID + " .mq-foot{margin-top:12px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));",
        "font-size:14px;color:var(--dsw-alias-label-caption,#8b949e);display:flex;gap:8px;}",
        "#" + PANEL_ID + " .mq-foot .mq-sp{margin-left:auto;}",
        // ---- two-column body: left = 用量 (usage log), right = 额度 (quota list)
        "#" + PANEL_ID + " .mq-cols{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,0.92fr);",
        "align-items:start;gap:0;}",
        "#" + PANEL_ID + " .mq-col-u{padding-right:18px;border-right:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));min-width:0;}",
        "#" + PANEL_ID + " .mq-col-q{padding-left:18px;min-width:0;}",
        "#" + PANEL_ID + " .mq-colhead{display:flex;align-items:baseline;gap:7px;font-weight:700;font-size:16px;",
        "padding-bottom:8px;margin-bottom:2px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));}",
        "#" + PANEL_ID + " .mq-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px;}",
        "#" + PANEL_ID + " .mq-kpi{padding:8px 10px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.08));",
        "display:flex;flex-direction:column;gap:2px;min-width:0;}",
        "#" + PANEL_ID + " .mq-kpi b{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;",
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "#" + PANEL_ID + " .mq-kpi span{font-size:14px;color:var(--dsw-alias-label-caption,#8b949e);}",
        "#" + PANEL_ID + " .mq-urow{margin-top:11px;min-width:0;}",
        "#" + PANEL_ID + " .mq-utop{display:flex;align-items:baseline;gap:8px;min-width:0;}",
        "#" + PANEL_ID + " .mq-uname{font-size:16px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "#" + PANEL_ID + " .mq-unum{margin-left:auto;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;}",
        "#" + PANEL_ID + " .mq-usub{font-size:14px;color:var(--dsw-alias-label-caption,#8b949e);margin-top:1px;",
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "#" + PANEL_ID + " .mq-uremain{font-size:14px;color:var(--dsw-alias-label-caption,#8b949e);margin-top:4px;}",
        "@media (max-width:820px){#" + PANEL_ID + " .mq-cols{grid-template-columns:1fr;}",
        "#" + PANEL_ID + " .mq-col-u{padding-right:0;border-right:none;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.08));}",
        "#" + PANEL_ID + " .mq-col-q{padding-left:0;padding-top:10px;}}",
        "#" + PANEL_ID + "::-webkit-scrollbar{width:10px;}",
        "#" + PANEL_ID + "::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,rgba(127,127,127,0.4));border-radius:999px;}",
        "#" + PANEL_ID + "::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb,rgba(127,127,127,0.6));}",
      ].join("");
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = css;
      document.head.appendChild(el);
    }

    // Magpie forwards the vendor's own window names ("5 hours", "7 days", "Credits",
    // "MCP · Month"). Codex words them the way a user thinks about a quota — plain
    // Chinese labels — so map them, and keep the original in the row's tooltip.
    function windowLabel(name) {
      const s = String(name || "").trim();
      if (!s) return "额度";
      let m = s.match(/^(\d+)\s*(h|hours?)$/i);
      if (m) return m[1] + " 小时用量上限";
      if (/5\s*小时/.test(s)) return "5 小时用量上限";
      m = s.match(/^(\d+)\s*(d|days?)$/i);
      if (m) return Number(m[1]) === 7 ? "每周限额" : m[1] + " 天用量上限";
      if (/每?周|week/i.test(s)) return "每周限额";
      if (/^1\s*(d|day|24\s*hours?)$/i.test(s) || /每天|每日|daily/i.test(s)) return "每日限额";
      if (/month|月度|每月/i.test(s)) return "月度限额";
      if (/credit|积分|points?/i.test(s)) return "额度";
      return s;
    }

    // Magpie hands windows over in its own order — Zhipu GLM lists "MCP · Month"
    // before "5 hours". Rank by real duration so every account reads short → long
    // (5 小时 → 每周 → 月度), which matches how the other providers are laid out.
    function windowRank(name) {
      const s = String(name || "").trim().toLowerCase();
      if (/month|月度|每月/.test(s)) return 1e5;
      let m = s.match(/^(\d+)\s*(h|hours?)$/);
      if (m) return Number(m[1]) * 60;
      if (/5\s*小时/.test(s)) return 300;
      m = s.match(/^(\d+)\s*(d|days?)$/);
      if (m) return Number(m[1]) * 1440;
      if (/week|周/.test(s)) return 7 * 1440;
      if (/day|每日|每天/.test(s)) return 1440;
      if (/credit|积分|points?/.test(s)) return 2e5;
      return 5e4;
    }

    // Reset cards: Magpie lists each card with the window it restores and its expiry
    // ("fiveHour" → 5 小时重置卡; anything else is treated as a full reset). Group by
    // kind + expiry so seven cards read as "5 小时 ×7 · 11-22 / 12-22 到期".
    function resetsHtml(r) {
      if (!r || typeof r !== "object") return "";
      const each = Array.isArray(r.each) ? r.each : null;
      let groups;
      if (each && each.length) {
        const bucket = new Map();
        each.forEach((c) => {
          const isFive = /five/i.test(String(c.window || ""));
          const kind = isFive ? "5 小时" : "完全";
          const day = String(c.until || "").slice(5, 10);
          const key = kind + "|" + day;
          bucket.set(key, { kind, day, n: (bucket.get(key) || { n: 0 }).n + 1 });
        });
        groups = Array.from(bucket.values());
      } else if (typeof r.count === "number" && r.count > 0) {
        groups = [{ kind: r.fiveHour === r.count ? "5 小时" : "完全", day: String(r.until || "").slice(5, 10), n: r.count }];
      } else {
        return "";
      }
      const parts = groups.map((g) => g.kind + " ×" + g.n + (g.day ? " · " + g.day + " 到期" : ""));
      const tip = groups.map((g) => g.kind + "重置卡 " + g.n + " 张 · " + (g.day || "未标注") + " 到期").join("\n");
      return (
        '<div class="mq-w" title="' + esc(tip) + '">' +
        '<span class="mq-wname">重置卡</span>' +
        '<span class="mq-wpct mq-wreset">' + esc(parts.join("；")) + "</span>" +
        "</div>"
      );
    }

    // Codex-style row: one muted label on the left, one quiet value on the right, no
    // progress bar and no traffic-light colouring — the number itself is the message.
    // Raw used/limit, reset time and the exhaustion projection move into the row's
    // tooltip, so the list stays scannable and reads like a settings table.
    function windowHtml(w, labelOverride) {
      const pct = roundPct(w.pct);
      const tip = [];
      if (w.display) tip.push("已用 " + w.display);
      else if (typeof w.amount === "number" && typeof w.limit === "number") tip.push("已用 " + w.amount + " / " + w.limit);
      const reset = fmtReset(w.resetsAt);
      if (reset) tip.push(reset);
      if (w.runsOutAt) {
        const cd = fmtCountdown(w.runsOutAt);
        if (cd && cd !== "已重置") tip.push("预计 " + cd + "后耗尽");
      }
      const label = labelOverride || windowLabel(w.name);
      const tipAll = [];
      if (w.name && w.name !== label) tipAll.push(w.name);
      tipAll.push.apply(tipAll, tip);
      return (
        '<div class="mq-w" title="' + esc(tipAll.length ? tipAll.join(" · ") : label) + '">' +
        '<span class="mq-wname">' + esc(label) + "</span>" +
        '<span class="mq-wpct">' + esc(leftText(pct)) + "</span>" +
        "</div>"
      );
    }

    // Balance amounts arrive as Magpie-formatted strings ("¥9.99", "$3.20", "12%"),
    // so we cannot threshold them numerically. Render them in the primary ink colour
    // (bold, tabular) so they read as the headline value in both light and dark themes.
    const BAL_COLOR = "var(--dsw-alias-label-primary,#e6edf3)";

    // Order the list by how much attention it needs: accounts Magpie could not read
    // (expired key…) first, then percent windows (tightest on top), then prepaid
    // balances, then unknown ones.
    function byUrgency(a, b) {
      const rank = (p) => (p.error ? 3 : Array.isArray(p.windows) && p.windows.length ? 2 : p.balance ? 1 : 0);
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return rb - ra;
      return (b.worstPct || 0) - (a.worstPct || 0);
    }

    // Magpie attaches the probe's failure text (e.g. "401 Unauthorized: …") to an
    // account it could not read. Turn that into something actionable in one line.
    function errHint(err) {
      const s = String(err || "");
      if (/401|unauthor|invalid.*(key|token)|api key/i.test(s)) return "API key 无效（401），请到 Magpie 里更新这个账号的 Key";
      if (/403|forbidden/i.test(s)) return "无权限（403），可能是 Key 权限或平台风控";
      if (/timeout|ETIMEDOUT|abort/i.test(s)) return "请求超时，稍后自动重试";
      if (/429|rate.?limit/i.test(s)) return "请求过于频繁（429），稍后自动重试";
      const one = s.replace(/\s+/g, " ").trim();
      return one.length > 60 ? one.slice(0, 60) + "…" : one;
    }

    // Magpie marks free tiers inconsistently: WorkBuddy carries plan="Free plan",
    // OpenCode Zen Free has "Free" in its display name, but Trae CN — also a free
    // account — has no marker at all (plan only says "Credits"). So: detect the two
    // data signals, and keep a tiny known-free list for the rest.
    const FREE_EXTRA = new Set(["trae-cn"]);
    function freeTag(p) {
      if (/\bfree\b|免费/i.test(String(p.plan || ""))) return "（免费账号）";
      if (/\bfree\b|免费/i.test(String(p.name || ""))) return ""; // the name already says it
      if (FREE_EXTRA.has(String(p.provider || "").toLowerCase())) return "（免费账号）";
      return "";
    }

    function providerHtml(p) {
      const windows = Array.isArray(p.windows) ? p.windows : [];
      const bal = p.balance ? String(p.balance) : "";
      const err = p.error ? String(p.error) : "";
      // Magpie sometimes ships raw strings like "Credits)" or a plan that just repeats
      // the account name; nothing of it belongs on the visible heading (the user wants
      // the bare provider name), so plan / account id go into the tooltip only.
      const planText = p.plan ? String(p.plan).replace(/[)\s]+$/, "").trim() : "";
      const planIsNoise = !planText || /^credits?$/i.test(planText) ||
        planText.replace(/\s+/g, "") === String(p.name || p.provider).replace(/\s+/g, "");
      const headTip = [planIsNoise ? "" : planText, p.user, p.provider].filter(Boolean).join(" · ");
      let body;
      if (windows.length) {
        const ordered = windows.slice()
          .sort((a, b) => windowRank(a && a.name) - windowRank(b && b.name));
        const labels = ordered.map((w) => windowLabel(w && w.name));
        // Two windows of the same period would read identically ("月度限额" twice), so
        // spell out the raw name only in that rare case.
        const seen = new Map();
        labels.forEach((l) => seen.set(l, (seen.get(l) || 0) + 1));
        const finalLabels = labels.map((l, i) =>
          seen.get(l) > 1 && ordered[i] && ordered[i].name
            ? l + "（" + String(ordered[i].name).trim() + "）"
            : l);
        body = ordered.map((w, i) => windowHtml(w, finalLabels[i])).join("") + resetsHtml(p.resets);
      } else if (bal) {
        body = '<div class="mq-w"><span class="mq-wname">余额</span>' +
          '<span class="mq-wpct">' + esc(bal) + "</span></div>";
      } else if (err) {
        body = '<div class="mq-w"><span class="mq-wname">状态</span>' +
          '<span class="mq-wpct mq-wfail">读取失败</span></div>' +
          '<div class="mq-user mq-err" title="' + esc(err) + '">' + esc(errHint(err)) + "</div>";
      } else {
        body = '<div class="mq-user">未提供余额（API key 型账号）</div>';
      }
      // Codex replication: heading is the provider name (16px bold) plus, for free
      // tiers, a muted 免费账号 suffix; then flat rows — label flush left, value flush
      // right, both in ordinary ink, nothing else.
      const fTag = freeTag(p);
      return (
        '<div class="mq-p">' +
        '<div class="mq-pname" title="' + esc(headTip) + '">' + esc(p.name || p.provider) +
        (fTag ? '<span class="mq-ptag">' + esc(fTag) + "</span>" : "") +
        "</div>" +
        body +
        "</div>"
      );
    }

    // ------------------------------------------------------------ card colour
    // By default the card borrows DSH's own palette through the --dsw-alias-* theme
    // variables, so it always matches the app. Because some users want to pin the card
    // to one look (and cannot find a global switch), the header carries a 配色 button
    // that cycles 跟随 DSH → 浅色 → 深色. The choice is remembered in localStorage.
    const THEME_KEY = "magpie-quota-card-theme";
    // Usage log time window (当前用量 tabs). "1d" is assembled by the host from
    // Magpie's daily series + request log; the rest map to Magpie's period param.
    const USAGE_PERIOD_KEY = "magpie-quota-usage-period";
    const USAGE_PERIODS = [
      { id: "1d", label: "当天" },
      { id: "7d", label: "7 天" },
      { id: "30d", label: "30 天" },
      { id: "all", label: "全部" },
    ];
    const USAGE_LABEL = { "1d": "当天", "7d": "近 7 天", "30d": "近 30 天", all: "全部" };
    const THEME_ORDER = ["auto", "light", "dark"];
    const THEME_LABEL = { auto: "跟随", light: "浅色", dark: "深色" };
    const THEME_TOKENS = {
      light: {
        "--dsw-alias-bg-layer-1": "#ffffff",
        "--dsw-alias-label-primary": "#0f1115",
        "--dsw-alias-label-secondary": "#4b5056",
        "--dsw-alias-label-tertiary": "#6f757c",
        "--dsw-alias-label-caption": "#8b9096",
        "--dsw-alias-border-l1": "rgba(0,0,0,0.07)",
        "--dsw-alias-border-l2": "rgba(0,0,0,0.14)",
        "--dsw-alias-interactive-bg-hover": "rgba(38,49,72,0.06)",
        "--dsw-alias-state-success-primary": "#16a34a",
        "--dsw-alias-state-warn-primary": "#d97706",
        "--dsw-alias-state-error-primary": "#dc2626",
        "--dsw-elevation-panel": "0 12px 32px rgba(15,17,21,0.16)",
        "--dsh-scrollbar-thumb": "rgba(0,0,0,0.22)",
      },
      dark: {
        "--dsw-alias-bg-layer-1": "#232324",
        "--dsw-alias-label-primary": "#f9fafb",
        "--dsw-alias-label-secondary": "#cfd3d6",
        "--dsw-alias-label-tertiary": "#adb2b8",
        "--dsw-alias-label-caption": "#81858c",
        "--dsw-alias-border-l1": "rgba(255,255,255,0.07)",
        "--dsw-alias-border-l2": "rgba(255,255,255,0.14)",
        "--dsw-alias-interactive-bg-hover": "rgba(255,255,255,0.08)",
        "--dsw-alias-state-success-primary": "#3fb950",
        "--dsw-alias-state-warn-primary": "#d29922",
        "--dsw-alias-state-error-primary": "#f85149",
        "--dsw-elevation-panel": "0 16px 48px rgba(0,0,0,0.5)",
        "--dsh-scrollbar-thumb": "rgba(255,255,255,0.22)",
      },
    };
    function readTheme() {
      try {
        const v = window.localStorage.getItem(THEME_KEY);
        return THEME_ORDER.indexOf(v) >= 0 ? v : "auto";
      } catch (e) {
        return "auto";
      }
    }
    let cardTheme = readTheme();
    function applyTheme() {
      if (!panelEl) return;
      Object.keys(THEME_TOKENS.light).forEach((k) => panelEl.style.removeProperty(k));
      const tokens = THEME_TOKENS[cardTheme];
      if (tokens) Object.keys(tokens).forEach((k) => panelEl.style.setProperty(k, tokens[k]));
    }

    // ------------------------------------------------- left column: 当前用量
    // Source: Magpie's usage log aggregate (/magpie/usage). Everything here is
    // "how much has already been consumed", so the right column can stay purely
    // "what is left / how much is allowed".
    function usageColumnHtml(u, kindOf, usagePeriod) {
      const active = USAGE_PERIODS.some((x) => x.id === usagePeriod) ? usagePeriod : "30d";
      const tabs = u && u.ok === true
        ? '<span class="mq-utabs">' +
          USAGE_PERIODS.map((x) =>
            '<button type="button" class="mq-btn mq-utab' + (x.id === active ? " mq-utab-on" : "") +
            '" data-mq-act="usage-period" data-mq-period="' + x.id + '" title="切换用量统计范围">' + x.label + "</button>"
          ).join("") + "</span>"
        : "";
      const head = '<div class="mq-colhead">当前用量' + tabs + "</div>";
      if (!u || u.ok !== true) {
        return (
          '<div class="mq-col mq-col-u">' + head +
          '<div class="mq-note">读不到 Magpie 的用量日志' + (u && u.message ? "：" + esc(u.message) : "") + "</div>" +
          "</div>"
        );
      }
      const t = u.totals || {};
      const kpi = (value, label) =>
        '<div class="mq-kpi"><b title="' + esc(String(value)) + '">' + esc(String(value)) + "</b><span>" + esc(label) + "</span></div>";
      const models = Array.isArray(u.models) ? u.models : [];
      // Any estimated (non-prepaid) provider in the list makes the total an estimate too.
      const anyEst = models.some((m) => m.cost > 0 && (!kindOf || kindOf(m.provider) !== "balance"));
      let h =
        '<div class="mq-col mq-col-u">' + head +
        '<div class="mq-kpis">' +
        kpi((anyEst ? "≈" : "") + fmtMoney(t.cost), "折算消耗") +
        kpi(fmtInt(t.calls), "调用") +
        kpi(fmtTok(t.input), "输入") +
        kpi(fmtTok(t.output), "输出") +
        "</div>";
      if (t.credits > 0) {
        h += '<div class="mq-uremain">积分消耗合计 ' + esc(fmtCredits(t.credits)) + "（订阅额度扣减，不折算成钱）</div>";
      }
      if (!models.length) {
        h += '<div class="mq-note">这段时间还没有调用记录。</div>';
      }
      const LIMIT = 8;
      // The source (Magpie provider) is always printed on the second line, so a model
      // served by several accounts (glm-5.3-flash via Zhipu vs WorkBuddy) stays clear.
      models.slice(0, LIMIT).forEach((m) => {
        const shown = m.name || m.model || "?";
        const src = String(m.sub || m.provider || "").split("·")[0].trim();
        const bits = [];
        if (src) bits.push(src);
        bits.push(fmtInt(m.calls) + " 次");
        if (m.input > 0) bits.push("入 " + fmtTok(m.input));
        if (m.output > 0) bits.push("出 " + fmtTok(m.output));
        if (m.cache_read > 0) bits.push("缓存 " + fmtTok(m.cache_read));
        const v = usageValue(m, kindOf);
        const vColor = v.tone === "none" ? "var(--dsw-alias-label-secondary,#8b949e)" : "var(--dsw-alias-label-primary,#e6edf3)";
        const vTitle =
          v.tone === "credits" ? "订阅/套餐积分计费：" + v.text
            : v.tone === "est" ? "套餐不按 token 实扣，此处是按官方挂牌价折算的估值"
            : v.tone === "real" ? "预充值余额实扣" : "";
        h +=
          '<div class="mq-urow">' +
          '<div class="mq-utop">' +
          '<span class="mq-uname" title="' + esc(shown + (src ? " · " + src : "")) + '">' + esc(shown) + "</span>" +
          '<span class="mq-unum" title="' + esc(vTitle) + '" style="color:' + vColor + '">' +
          esc(v.text) + "</span>" +
          "</div>" +
          '<div class="mq-usub" title="' + esc(bits.join(" · ")) + '">' + esc(bits.join(" · ")) + "</div>" +
          "</div>";
      });
      if (models.length > LIMIT) {
        h += '<div class="mq-note">还有 ' + (models.length - LIMIT) + " 个模型未列出</div>";
      }
      if (t.unpriced > 0) {
        h += '<div class="mq-note">其中 ' + fmtInt(t.unpriced) + " 次调用没有价格（走订阅积分），不计入消耗金额。</div>";
      }
      if (anyEst) {
        h += '<div class="mq-note">≈ 挂牌价折算（套餐不实扣）· 积分 订阅额度消耗 · ¥ 预充值实扣</div>';
      }
      return h + "</div>";
    }

    // ------------------------------------------------- right column: 额度
    function quotaColumnHtml(state, providers) {
      let body;
      if (state.error) {
        body =
          '<div class="mq-empty mq-err">连不上 Magpie：' + esc(state.error) + "</div>" +
          '<div class="mq-note">请确认 Magpie 托盘程序在运行（默认端口 3425）。</div>';
      } else if (providers.length === 0) {
        body = '<div class="mq-empty">Magpie 当前没有已接入的账号。</div>';
      } else {
        body = providers.map(providerHtml).join("");
      }
      return '<div class="mq-col mq-col-q"><div class="mq-colhead">额度</div>' + body + "</div>";
    }

    function panelHtml(state) {
      const data = state.data;
      const providers = data && Array.isArray(data.providers) ? data.providers.slice() : [];
      providers.sort(byUrgency);
      let html =
        '<div class="mq-head">' +
        '<span class="mq-title">Magpie 额度</span>' +
        (data && data.version ? '<span class="mq-ver">v' + esc(data.version) + "</span>" : "") +
        '<span class="mq-tools">' +
        '<button type="button" class="mq-btn" data-mq-act="theme" title="切换卡片配色：跟随 DSH / 浅色 / 深色">配色：' +
        (THEME_LABEL[cardTheme] || "跟随") + "</button>" +
        '<button type="button" class="mq-btn" data-mq-act="refresh">' + (state.loading ? "刷新中…" : "刷新") + "</button>" +
        "</span>" +
        "</div>";
      // Sticky one-line summary of every prepaid-balance account (e.g. DeepSeek ¥9.99),
      // so the number is visible without scrolling past the percent-based providers.
      const balProviders = providers.filter((p) => p.balance && !(Array.isArray(p.windows) && p.windows.length));
      if (!state.error && balProviders.length) {
        html +=
          '<div class="mq-balrow">' +
          '<span class="mq-balitem" style="color:var(--dsw-alias-label-caption,#8b949e)">余额</span>' +
          balProviders
            .map((p) => '<span class="mq-balitem">' + esc(shortName(p)) + "<b>" + esc(String(p.balance)) + "</b></span>")
            .join("") +
          "</div>";
      }
      // Join usage rows to quota entries by provider id so each row can show the unit
      // its provider actually settles in (credits / estimate / prepaid money).
      const kindMap = {};
      providers.forEach((p) => {
        if (p && p.provider) kindMap[p.provider] = p.kind;
      });
      const kindOf = (id) => (id && kindMap[id]) || null;
      html +=
        '<div class="mq-cols">' +
        usageColumnHtml(state.usage, kindOf, state.usagePeriod) +
        quotaColumnHtml(state, providers) +
        "</div>";
      const at = data && data.fetchedAt ? fmtClock(data.fetchedAt) : null;
      html +=
        '<div class="mq-foot">' +
        "<span>" + esc(data && data.base ? data.base.replace(/^https?:\/\//, "") : "127.0.0.1:3425") + "</span>" +
        (at ? "<span>· 更新 " + esc(at) + "</span>" : "") +
        '<span class="mq-sp">每 60s 自动刷新</span>' +
        "</div>";
      return html;
    }

    // ---------------------------------------------------------- panel mounting

    let panelEl = null;
    let panelActions = null;
    let panelStateRef = null;
    let onPanelClick = null;

    function mountPanel() {
      if (panelEl) return panelEl;
      ensureStyles();
      panelEl = document.createElement("div");
      panelEl.id = PANEL_ID;
      panelEl.setAttribute("data-mq-panel", "1");
      onPanelClick = (e) => {
        const btn = e.target && e.target.closest ? e.target.closest("[data-mq-act]") : null;
        if (!btn) return;
        const act = btn.getAttribute("data-mq-act");
        if (act === "refresh" && panelActions) {
          e.preventDefault();
          e.stopPropagation();
          panelActions.refresh(true);
        } else if (act === "usage-period" && panelActions) {
          e.preventDefault();
          e.stopPropagation();
          panelActions.setUsagePeriod(btn.getAttribute("data-mq-period"));
        } else if (act === "theme") {
          e.preventDefault();
          e.stopPropagation();
          const i = THEME_ORDER.indexOf(cardTheme);
          cardTheme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
          try { window.localStorage.setItem(THEME_KEY, cardTheme); } catch (err) {}
          applyTheme();
          syncPanel();
        }
      };
      panelEl.addEventListener("click", onPanelClick);
      document.body.appendChild(panelEl);
      applyTheme();
      return panelEl;
    }

    function syncPanel() {
      if (!panelEl || !panelStateRef) return;
      panelEl.innerHTML = panelHtml(panelStateRef());
    }

    function unmountPanel() {
      if (!panelEl) return;
      try {
        if (onPanelClick) panelEl.removeEventListener("click", onPanelClick);
        if (panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      } catch (e) {}
      panelEl = null;
      panelActions = null;
      panelStateRef = null;
      onPanelClick = null;
    }

    function StatusPill(props, timer) {
      const [state, setState] = React.useState(() => {
        let p = "30d";
        try { p = window.localStorage.getItem(USAGE_PERIOD_KEY) || "30d"; } catch (e) {}
        return { data: null, usage: null, error: null, loading: true, loadedAt: 0, usagePeriod: p };
      });
      const [open, setOpen] = React.useState(false);
      const stateRef = React.useRef(state);
      stateRef.current = state;
      const usagePeriodRef = React.useRef(state.usagePeriod);

      const load = React.useCallback(async (force) => {
        setState((s) => ({ data: s.data, usage: s.usage, error: s.error, loading: true, loadedAt: s.loadedAt, usagePeriod: s.usagePeriod }));
        const q = force ? "?force=1" : "";
        const qUsage = "/magpie/usage" + (force ? "?force=1&" : "?") + "period=" + encodeURIComponent(usagePeriodRef.current || "30d");
        // Quota + usage are independent: a broken usage log must not hide the quotas.
        const [quotaRes, usageRes] = await Promise.allSettled([
          fetch("/magpie/quotas" + q, { headers: { accept: "application/json" } }).then((r) => r.json()),
          fetch(qUsage, { headers: { accept: "application/json" } }).then((r) => r.json()),
        ]);
        const quota = quotaRes.status === "fulfilled" ? quotaRes.value : null;
        const usage = usageRes.status === "fulfilled" ? usageRes.value : null;
        const usageOk = usage && usage.ok === true ? usage : null;
        if (!quota || quota.ok !== true) {
          const msg =
            (quota && quota.message) ||
            (quotaRes.status === "rejected" ? String((quotaRes.reason && quotaRes.reason.message) || quotaRes.reason) : "unknown error");
          setState((s) => ({ data: null, usage: usageOk, error: msg, loading: false, loadedAt: Date.now(), usagePeriod: s.usagePeriod }));
          return;
        }
        setState((s) => ({ data: quota, usage: usageOk, error: null, loading: false, loadedAt: Date.now(), usagePeriod: s.usagePeriod }));
      }, []);

      // Tab switch: re-fetch only the usage half with the new window.
      const setUsagePeriod = React.useCallback(async (p) => {
        if (!USAGE_PERIODS.some((x) => x.id === p)) return;
        try { window.localStorage.setItem(USAGE_PERIOD_KEY, p); } catch (e) {}
        usagePeriodRef.current = p;
        setState((s) => ({ data: s.data, usage: s.usage, error: s.error, loading: true, loadedAt: s.loadedAt, usagePeriod: p }));
        try {
          const r = await fetch("/magpie/usage?force=1&period=" + encodeURIComponent(p), { headers: { accept: "application/json" } }).then((x) => x.json());
          const u = r && r.ok === true ? r : null;
          setState((s) => ({ data: s.data, usage: u, error: s.error, loading: false, loadedAt: Date.now(), usagePeriod: p }));
        } catch (e) {
          setState((s) => ({ data: s.data, usage: s.usage, error: s.error, loading: false, loadedAt: s.loadedAt, usagePeriod: p }));
        }
      }, []);

      React.useEffect(() => {
        load(false);
        const dispose = timer.interval(() => load(false), REFRESH_INTERVAL_MS);
        return () => {
          try { dispose(); } catch (e) {}
          unmountPanel();
        };
      }, [load, timer]);

      // Mount / unmount the body-level panel with `open`.
      React.useEffect(() => {
        if (open) {
          panelStateRef = () => stateRef.current;
          panelActions = { refresh: load, setUsagePeriod };
          mountPanel();
          syncPanel();
        } else {
          unmountPanel();
        }
      }, [open, load]);

      // Re-render panel contents whenever data changes while open.
      React.useEffect(() => {
        if (open) syncPanel();
      }, [state, open]);

      // Click outside + Escape close the panel.
      React.useEffect(() => {
        const onDoc = (e) => {
          if (!panelEl) return;
          if (panelEl.contains(e.target)) return;
          if (e.target && e.target.closest && e.target.closest("[data-mq-pill]")) return;
          setOpen(false);
        };
        const onKey = (e) => {
          if (e.key === "Escape" && panelEl) setOpen(false);
        };
        document.addEventListener("mousedown", onDoc, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
          document.removeEventListener("mousedown", onDoc, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, []);

      const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && Date.now() - state.loadedAt > STALE_MS) load(true);
      };

      const data = state.data;
      const providers = data && Array.isArray(data.providers) ? data.providers : [];
      const sorted = providers.slice().sort(byUrgency);
      const worst = sorted[0];
      const hasWin = worst && Array.isArray(worst.windows) && worst.windows.length > 0;
      const dotColor = state.error
        ? "#8b949e"
        : hasWin
        ? pctColor(worst.worstPct)
        : worst && worst.balance
        ? BAL_COLOR
        : "#3fb950";
      let label = "Magpie —";
      if (state.error) label = "Magpie 离线";
      else if (providers.length > 0) {
        // Plain "用量/额度" on the chip; the numbers live in the tooltip and the panel,
        // so the chip stays the same width no matter which provider is tightest.
        label = "用量/额度";
      }
      const usageTip =
        state.usage && state.usage.ok === true && state.usage.totals
          ? (USAGE_LABEL[state.usage.period || "30d"] || state.usage.period) + " 折算 " + fmtMoney(state.usage.totals.cost) + " / " + fmtInt(state.usage.totals.calls) + " 次调用 · "
          : "";
      const tooltip = state.error
        ? "连不上 Magpie (" + state.error + ")"
        : usageTip +
          (providers.map((p) => p.name + " " + (Array.isArray(p.windows) && p.windows.length ? leftText(p.worstPct) : p.balance || "—")).join(" · ") || "Magpie 无数据") +
          "（共 " + providers.length + " 项，点击查看详情）";

      return React.createElement(
        "button",
        {
          type: "button",
          "data-mq-pill": "1",
          onClick: toggle,
          title: tooltip,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 28,
            padding: "0 7px",
            border: "1px solid transparent",
            borderRadius: 8,
            background: open ? "rgba(127,127,127,0.14)" : "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: 12.5,
            cursor: "pointer",
            whiteSpace: "nowrap",
            opacity: 0.88,
            verticalAlign: "middle",
          },
        },
        React.createElement("span", {
          style: { width: 7, height: 7, borderRadius: 999, background: dotColor, boxShadow: "0 0 0 2px rgba(127,127,127,0.15)", flex: "0 0 auto" },
        }),
        React.createElement("span", { style: { fontWeight: 600 } }, label)
      );
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== "function") {
        console.log("[dsh-magpie-client] skip: slots service unavailable");
        return;
      }
      const timer = ctx.timer;
      slots.inject("conversation.input.right", function* () {
        yield slots.register(
          { name: "conversation.input.right", id: "dsh-magpie", order: 0, label: "dsh-magpie" },
          (props) => StatusPill(props, timer)
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "timer"];
    exports.__debug_panelHtml = panelHtml; // exposed only for offline smoke tests
    exports.__debug_styles = ensureStyles;
    return module.exports;
  },
});
