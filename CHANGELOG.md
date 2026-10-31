# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The usage column now reads Magpie's **request-log aggregate**
  (`/v1/magpie/usage/requests`) — the exact endpoint its own 用量 dashboard renders.
  The previous `/v1/magpie/usage` endpoint only counted gateway-reported calls, so it
  omitted the "local session" (`session-unknown`) traffic the harness makes and
  under-reported by ~2–5×. Totals now line up with the Magpie page.
- The usage panel mirrors the Magpie 用量 page: four headline cards — **Token**
  (输入/输出/缓存), **请求** (含失败数), **费用** (美元挂牌价折算, `≈` when some calls are
  unpriced), **缓存命中率** — followed by a per-**provider** breakdown (本地会话, plus
  each connected provider). Cost is shown in `$` to match Magpie (it used to be `¥`).
- The per-period tabs (当天/7天/30天/全部) all use the same endpoint with Magpie's own
  period param, so every tab matches the corresponding Magpie view.

## [0.3.3] — 2026-10-29

### Changed

- Published to npm as **`dsh-magpie-quota`** (the bare `dsh-magpie` name was already
  taken by an unrelated placeholder package). Plugin ids inside the package were
  renamed to match, so `dsh plugin add dsh-magpie-quota` installs the same plugin as
  `dsh plugin add github:Hongcheng-LI/dsh-magpie`.

## [0.3.2] — 2026-10-29

### Fixed

- Windows always render short → long (5 小时 → 每周 → 月度) regardless of the order
  Magpie returns them in. Zhipu GLM used to list its `MCP · Month` window above the
  5-hour one while every other account did the opposite.
- The monthly window is labelled plain `月度限额`; Magpie's `MCP · Month` product
  prefix no longer shows up in the row label (the raw name stays in the tooltip, and
  it is spelled out only if one account has two windows of the same period).
- `scripts/preview.mjs` now feeds the panel through the real host half, so previews
  show the same percentages as the app (it used to render every window as `—`), and
  the panel stylesheet is actually inlined instead of silently dropped.

## [0.3.1] — 2026-10-28

### Added

- Test suite for both halves (`node --test tests/`): 15 assertions' worth of
  client rendering and host routing, run offline against stubs.
- GitHub Actions CI (syntax check, tests, manifest lint) on Node 22.
- `docs/ARCHITECTURE.md` — the two halves, the trusted-request guard, and why
  the host half exists.
- `scripts/preview.mjs` — renders the panel with live Magpie data for design
  review without opening DSH.

### Fixed

- The 60-second auto-refresh dropped `usagePeriod` while in the loading state,
  so the active period pill snapped back to 30 天 until the next manual click.
- A failed period switch left the panel spinning forever instead of restoring
  the previous data.
- The 当天 aggregation had no time budget; a slow gateway could keep paginating
  requests rows indefinitely. It now stops after 10 s.

### Changed

- `package.json` gained `scripts`, explicit `files`, and an `engines` floor of
  Node 22 to match the harness.

## [0.3.0] — 2026-10-27

### Added

- Period switch on the usage column: 当天 / 7 天 / 30 天 / 全部. The choice is
  remembered per browser.

## [0.2.0] — 2026-10-26

### Added

- Prepaid balances: providers whose Magpie entry is `kind: balance` (DeepSeek,
  New-API relay stations) render a 余额 row with the amount, instead of being
  dropped from the panel.

## [0.1.0] — 2026-10-25

### Added

- First working version: a pill in the composer, a two-column panel, quota
  windows with reset cards, per-model usage, free-account tagging, and the
  follow-DSH / light / dark theme toggle.
