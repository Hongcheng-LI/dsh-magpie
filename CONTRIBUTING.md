# Contributing

Thanks for taking a look. This is a small plugin and the rules are small too.

## Run it locally

```bash
git clone https://github.com/Hongcheng-LI/dsh-magpie
cd dsh-magpie
dsh plugin --profile desktop add "$PWD"     # symlinks the working copy into your profile
```

The client half hot-reloads on page refresh. The host half (anything under
`dsh/index.js`) is loaded once at boot — **restart DSH** to see host changes.

You need [Magpie](https://github.com/magpie-community) running on
`127.0.0.1:3425` to see real data. Without it the panel shows its offline state,
which is a valid thing to test.

## Test

```bash
node --check dsh/index.js && node --check dsh/client.js
node --test tests/client.test.mjs tests/host.test.mjs
```

Both suites are offline: the client tests stub `document` / `__ModuleLoader__`,
the host tests stub the kernel and `globalThis.fetch`. If a change needs a live
Magpie to verify, say so in the PR and paste the endpoint output instead.

## Style

- The host half is ESM and stays Node-free of browser globals; the client half
  is plain browser script registered through `window.__ModuleLoader__.load`.
  Nothing in `dsh/client.js` may touch `process` at module scope.
- Keep the panel's type scale: 16 px for names and headline numbers, 14 px for
  everything else. It is deliberately matched to DSH's own type, not invented.
- Any new number that ends up on screen should come from Magpie, not be guessed.
  If the gateway does not expose it, show nothing rather than a plausible lie.

## Pull requests

- One concern per PR. A rendering tweak and a routing change belong in two.
- Include a screenshot from `node scripts/preview.mjs` when the panel changes.
- The CI job runs the same three commands as above; a red check means one of
  them failed, and the log names which.
