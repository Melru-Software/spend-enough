# Spend Enough

A single-page retirement / "spend it down" scenario tool. Plain HTML, CSS, and
vanilla JS — **no build step**. Chart.js is loaded from a CDN.

> Educational modelling tool, not financial advice.

## Files

| File | What it is |
|------|------------|
| `index.html` | Landing page (headline, what-ifs, founder story, how it works, email capture, footer). |
| `app.html`   | The app: markup, styles, and all UI logic (state, rendering, charts, handlers, modals, paywall). |
| `engine.js`  | The pure simulation engine + tax/Social-Security estimators. **No DOM.** Loaded by `app.html` (attaches its exports to `window`) and by `tests.js` (via `require`). |
| `config.js`  | Public deployment values (checkout URL, price, email endpoint, analytics, site URL). No secrets; every value is visible to visitors by design. |
| `privacy.html`, `terms.html` | Legal pages. Drafts with `[BUSINESS NAME]`-style placeholders the owner must fill before launch. |
| `data/shiller_stock_market_data.csv` | Snapshot of Robert Shiller's monthly dataset (through 2025-12). |
| `data/build_returns.js` | Rebuilds the two annual real-return arrays in `engine.js` from the snapshot and documents the method. |
| `tests.js`   | Node test suite for the engine. No framework, no dependencies. |
| `LAUNCH.md`, `LAUNCH_LOG.md`, `docs/launch/` | The ship plan, its running log, and the Phase 1–3 audit reports. |

## Run it

It's static — serve the folder over HTTP (needed for the Chart.js CDN and fonts):

```sh
python3 -m http.server 8137
# then visit http://localhost:8137/         (landing)
#            http://localhost:8137/app.html (the app)
```

## Tests

```sh
node tests.js      # exit 0 = all pass
```

Covered: success rate stays in `[0,1]`; a depleted portfolio never recovers;
`findMaxSpend` lands near the end-goal buffer; more spending never *increases* the
success rate (guardrails on and off); the tax / Social Security estimators against the
verified 2026 IRS and SSA figures; reference withdrawal scenarios against Trinity-study
ballparks at 100% stocks and 60/40; the return series' statistics; seeded Monte Carlo
reproducibility; median-path and failure-count semantics; the historical max-spend search;
the wage vs retirement tax split; and guardrail anchoring.

### Run tests automatically on commit

A pre-commit hook lives in `.githooks/`. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

The same suite runs in CI on every push / PR via `.github/workflows/test.yml`.

## Data sources

- **Market returns, 1926–2025 (real):** two annual series, both derived from Robert
  Shiller's U.S. stock market dataset (Yale) by `data/build_returns.js`:
  S&P composite total return (dividends reinvested) and 10-year U.S. Treasury total return
  (constant-maturity approximation), each deflated by CPI, January to January. 2025 is a
  partial year (January to December). The engine blends them by the user's stock share,
  rebalanced yearly. To refresh: replace the CSV snapshot, run `node data/build_returns.js`,
  paste the two arrays into `engine.js`, run `node tests.js`.
- 2026 federal brackets & standard deduction: IRS Rev. Proc. 2025-32.
- 2026 Social Security wage base ($184,500) and PIA bend points ($1,286 / $7,749): SSA.
- 2025 California brackets, standard deduction & 1% mental-health surcharge: CA FTB.
  Other states: flat approximations from the Tax Foundation.

Every modelling assumption and default is shown to the user in the app's **Assumptions**
panel (asset mix, fees, spending rule and guardrails, tax rates, horizon, Social Security,
Monte Carlo seed/parameters) and can be changed there. Known simplifications are listed in
the app's "Read this first" note and FAQ, and in code comments in `engine.js`.

## Deploying

The site is static files at the repo root, so any static host works. Recommended:
**Netlify** (or Cloudflare Pages): connect the GitHub repo, no build command, publish
directory `/`. Every push to `main` deploys.

1. Fill in `config.js` (checkout URL and price from the payment provider, optional email
   endpoint and analytics, and `siteUrl` once the domain exists). Commit.
2. Fill the placeholders in `privacy.html` and `terms.html` (`[BUSINESS NAME]`,
   `[CONTACT EMAIL]`, `[DATE]`, `[STATE]`, `[PAYMENT PROCESSOR]`, `[ANALYTICS PROVIDER]`,
   `[HOST]`) and review the `TODO` boxes. Commit.
3. Replace the results-screen mock and the `og:image` placeholder in `index.html` with real
   images (`results-screen.png`, `og-image.png`).
4. Create the host account, import the repo, deploy. Add the custom domain in the host
   dashboard and follow its DNS instructions.
5. Payments (Lemon Squeezy recommended, merchant of record): create the product
   "Spend Enough Pro — founder lifetime" at the configured price, copy the hosted checkout
   URL into `config.js`. License keys are UUIDs; the app accepts them pasted into the unlock
   screen or via `app.html?key=<KEY>` if the provider's redirect can insert them.

There are no server-side secrets: nothing in this repo needs an environment variable.
