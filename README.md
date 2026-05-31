# Financial planner (working name)

A single-page retirement / "spend it down" planning tool. Plain HTML, CSS, and
vanilla JS — **no build step**. Chart.js is loaded from a CDN.

> Educational planning tool, not financial advice.

## Files

| File | What it is |
|------|------------|
| `index.html` | The app: markup, styles, and all UI logic (state, rendering, charts, handlers, modals). |
| `engine.js`  | The pure simulation engine + tax/Social-Security estimators. **No DOM.** Loaded by `index.html` (attaches its exports to `window`) and by `tests.js` (via `require`). |
| `tests.js`   | Node test suite for the engine. No framework, no dependencies. |

## Run it

It's static — open `index.html` over HTTP (needed for the Chart.js CDN):

```sh
python3 -m http.server 8137
# then visit http://localhost:8137/
```

## Tests

```sh
node tests.js      # exit 0 = all pass
```

Covered: success rate stays in `[0,1]`; a depleted portfolio never recovers;
`findMaxSpend` lands near the end-goal buffer (not millions); more spending never
*increases* the success rate (guardrails on and off); and the tax / Social Security
estimators against the verified 2026 IRS and SSA figures.

### Run tests automatically on commit

A pre-commit hook lives in `.githooks/`. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

The same suite runs in CI on every push / PR via `.github/workflows/test.yml`.

## Data sources (verified)

- S&P 500 real (inflation-adjusted) total returns 1926–2025: us500.com / Shiller CPI series.
- 2026 federal brackets & standard deduction: IRS Rev. Proc. 2025-32.
- 2026 Social Security wage base ($184,500) and PIA bend points ($1,286 / $7,749): SSA.
- 2025 California standard deduction & 1% mental-health surcharge: CA FTB.

See code comments in `engine.js` for known modeling simplifications (single-year
AIME for Social Security, guardrail reference-rate anchoring, `findMaxSpend` bounds).
