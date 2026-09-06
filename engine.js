/* ============================================================================
   SPEND ENOUGH — SIMULATION ENGINE  (engine.js)
   ----------------------------------------------------------------------------
   Pure, DOM-free simulation + estimator code. Loaded by index/app.html via
   <script src="engine.js"> (attaches all symbols to window) and by tests.js
   via require() in Node. NO DOM, NO build step — plain ES2017.

   Contents:
     1. CONSTANTS & HISTORICAL DATA ... STOCK_RETURNS, BOND_RETURNS, blends, stats
     2. SIMULATION ENGINE ............. withdrawWithTax, simulateOnce,
                                        runFixed/runHistorical/runMonteCarlo,
                                        runForState, runNamedScenario,
                                        findMaxSpend, findMaxSpendAtSuccess
     3. TAX & SOCIAL SECURITY ......... brackets, estimateNetIncome, estimateSSBenefit
     4. DEFAULT_STATE / SAMPLE_STATE

   NOTE: all money is in today's (real, inflation-adjusted) dollars.
============================================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node (tests.js)
  else Object.assign(root, api);                                            // browser: globals on window
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

const CURRENT_YEAR = new Date().getFullYear();

// ============================================================================
// HISTORICAL DATA
// ----------------------------------------------------------------------------
// Annual REAL (inflation-adjusted) total returns, 1926-2025, one value per year.
// Both series are derived from Robert Shiller's U.S. stock market dataset (Yale;
// monthly S&P composite price, dividends, CPI, and 10-year Treasury yield since
// 1871) by data/build_returns.js, which documents the exact method. In short:
//   STOCK_RETURNS  S&P composite, dividends reinvested, January to January, deflated by CPI.
//   BOND_RETURNS   10-year U.S. Treasury held one year (constant-maturity approximation:
//                  coupon at the January yield plus the price change from the yield move),
//                  deflated by CPI. No credit risk, no fees.
// The 2025 value in each series runs January to December (January 2026 was not yet
// published), so it is a partial year.
// Rebuild: node data/build_returns.js  (reads data/shiller_stock_market_data.csv).
// These are NOT the Ibbotson SBBI series used by Bengen (1994) or the Trinity Study;
// those included intermediate-term government / long corporate bonds and run to a
// different end year. Expect agreement within a few periods, not identical counts.
const HISTORICAL_START_YEAR = 1926;
const STOCK_RETURNS = [
  0.1354,0.3785,0.4815,-0.09,-0.1624,-0.3641,0.0283,0.5186,-0.1056,0.5124,
  0.2926,-0.3179,0.183,0.0352,-0.1019,-0.177,0.1198,0.1983,0.1654,0.3544,
  -0.2499,-0.067,0.0805,0.1898,0.2356,0.1627,0.1373,0.0156,0.4668,0.2801,
  0.0387,-0.0887,0.3761,0.0647,0.0449,0.1816,-0.0408,0.1896,0.1469,0.0932,
  -0.0956,0.1197,0.0589,-0.1364,0.0174,0.1026,0.1352,-0.2317,-0.2902,0.3001,
  0.0569,-0.1455,0.0632,0.0272,0.1231,-0.1402,0.2427,0.1542,0.0392,0.2122,
  0.2912,-0.0582,0.1247,0.1679,-0.0604,0.2829,0.0422,0.0884,-0.0164,0.314,
  0.2333,0.2575,0.2914,0.1242,-0.0854,-0.1442,-0.2205,0.2585,0.0292,0.0582,
  0.1092,-0.0536,-0.3521,0.2936,0.1429,0.0039,0.1422,0.2341,0.1343,-0.0465,
  0.1798,0.222,-0.0615,0.248,0.1593,0.1366,-0.1728,0.1965,0.2203,0.1246
];
const BOND_RETURNS = [
  0.0872,0.0461,0.0247,0.0598,0.1067,0.1205,0.1808,0.024,0.0261,0.0239,
  0.0023,0.029,0.0565,0.0432,0.0286,-0.121,-0.0489,-0.0055,0.0104,0.0154,
  -0.139,-0.0862,0.0219,0.044,-0.0717,-0.0252,0.0112,0.0444,0.0221,-0.0003,
  -0.0423,0.0261,-0.0515,-0.0203,0.0944,0.0138,0.0456,-0.0032,0.0302,-0.0076,
  0.0132,-0.0546,-0.0223,-0.1052,0.1228,0.0479,-0.0106,-0.0584,-0.0721,-0.0069,
  0.0565,-0.0404,-0.0744,-0.1255,-0.0917,-0.0517,0.3301,-0.0025,0.0939,0.1975,
  0.2112,-0.0637,0.0143,0.0888,0.0313,0.1207,0.0641,0.0968,-0.0958,0.1924,
  -0.0346,0.1204,0.0961,-0.1055,0.1303,0.0481,0.0954,0.0136,0.0065,-0.0118,
  -0.001,0.0782,0.1342,-0.0898,0.0462,0.1173,0.0085,-0.07,0.11,-0.0118,
  -0.0305,-0.0081,0,0.0787,0.0608,-0.1118,-0.1701,-0.0339,-0.0297,0.0653
];
const HISTORICAL_RETURNS = STOCK_RETURNS; // back-compat alias (100% stocks)
const HISTORICAL_END_YEAR = HISTORICAL_START_YEAR + STOCK_RETURNS.length - 1;
const HISTORICAL_PARTIAL_YEARS = [2025];
const DATA_SOURCE = {
  name: 'Robert Shiller, U.S. Stock Markets 1871-Present and CAPE Ratio (Yale)',
  url: 'http://www.econ.yale.edu/~shiller/data.htm',
  snapshot: 'data/shiller_stock_market_data.csv (rows through 2025-12)',
  builder: 'data/build_returns.js',
};

// Portfolio blend: stockPct in stocks, the rest in 10-year Treasuries, rebalanced yearly.
const _blendCache = {};
function blendSeries(stockPct) {
  const w = clamp01(stockPct === undefined || stockPct === null ? 1 : stockPct);
  const key = w.toFixed(4);
  if (!_blendCache[key]) _blendCache[key] = STOCK_RETURNS.map((s, i) => w * s + (1 - w) * BOND_RETURNS[i]);
  return _blendCache[key];
}
function clamp01(x) { return Math.max(0, Math.min(1, +x || 0)); }

function getHistoricalSequence(startYear, numYears, stockPct) {
  const series = blendSeries(stockPct);
  const startIdx = startYear - HISTORICAL_START_YEAR;
  if (startIdx < 0 || startIdx + numYears > series.length) return null;
  return series.slice(startIdx, startIdx + numYears);
}

// Arithmetic mean, sample standard deviation, geometric (compound) mean of a return series.
function seriesStats(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0;
  const geo = Math.exp(arr.reduce((a, b) => a + Math.log(1 + b), 0) / n) - 1;
  return { n, mean, sd, geo, min: Math.min.apply(null, arr), max: Math.max.apply(null, arr) };
}
function historicalStats(stockPct) { return seriesStats(blendSeries(stockPct)); }

// Named historical scenarios for stress tests
const HISTORICAL_SCENARIOS = [
  { id: 'depression', name: 'Great Depression', startYear: 1929, description: 'Markets lost most of their real value over three years; deflation followed.' },
  { id: 'postwar', name: 'Post-war boom', startYear: 1950, description: 'Strong growth and rising wages through the 1950s and 60s.' },
  { id: 'stagflation', name: '1970s stagflation', startYear: 1969, description: 'High inflation and oil shocks; real returns were negative for a decade.' },
  { id: 'reagan', name: '1980s bull market', startYear: 1982, description: 'Falling interest rates fueled a long equity rally.' },
  { id: 'dotcom', name: 'Dot-com to 2008', startYear: 2000, description: 'Two major crashes within a decade, a hard sequence for retirees.' },
];

// ============================================================================
// SIMULATION ENGINE
// ============================================================================

// Tax rate applied to money coming OUT in retirement (traditional-IRA withdrawals and
// half of Social Security). Falls back to the wage rate when not set separately.
function retirementTaxRate(state) {
  return (state.retirementTaxRate === null || state.retirementTaxRate === undefined) ? state.taxRate : state.retirementTaxRate;
}

function withdrawWithTax(netNeed, accts, strategy, age, state) {
  // Returns { gross, tax, drawn: {traditional, roth, taxable} }
  // netNeed is the after-tax cash required from the portfolio.
  // We gross up per account so that (gross - tax) covers netNeed.
  const penalty = age < 59.5 ? 0.10 : 0;
  const effRate = {
    traditional: Math.min(0.95, retirementTaxRate(state) + penalty),
    roth: penalty, // contributions assumed tax-free; only early penalty applies
    taxable: state.capGainsTax * 0.5, // ~half the withdrawal is gain, taxed at cap gains
  };
  const order = strategy === 'taxSmart'
    ? ['taxable', 'traditional', 'roth']
    : null;

  const drawn = { traditional: 0, roth: 0, taxable: 0 };
  let tax = 0;
  let gross = 0;

  if (strategy === 'proportional') {
    const total = accts.traditional + accts.roth + accts.taxable;
    if (total <= 0) return { gross: netNeed, tax: 0, drawn };
    for (const k of ['traditional', 'roth', 'taxable']) {
      const share = netNeed * (accts[k] / total);
      const g = share / (1 - effRate[k]);
      drawn[k] = g;
      tax += g * effRate[k];
      gross += g;
    }
    return { gross, tax, drawn };
  }

  // taxSmart: draw in order, grossing up per account
  let remaining = netNeed;
  for (const k of order) {
    if (remaining <= 0) break;
    const avail = accts[k];
    if (avail <= 0) continue;
    // Max net we can get from this account = avail * (1 - effRate)
    const maxNet = avail * (1 - effRate[k]);
    const takeNet = Math.min(remaining, maxNet);
    const g = takeNet / (1 - effRate[k]);
    drawn[k] = g;
    tax += g * effRate[k];
    gross += g;
    remaining -= takeNet;
  }
  if (remaining > 0) {
    // Not enough across accounts; reflect the shortfall as extra gross
    gross += remaining;
  }
  return { gross, tax, drawn };
}

// Market shock: replace the returns from `shockAge` onward with the first ten years of a
// named era (real returns for the user's mix), in every period, simulation, or fixed
// path. Answers "what if that decade hits right when I stop working?".
const SHOCK_YEARS = 10;
function applyShock(seq, state) {
  if (!state.shockEra || state.shockAge === null || state.shockAge === undefined) return seq;
  const era = HISTORICAL_SCENARIOS.find(x => x.id === state.shockEra);
  if (!era) return seq;
  const idx = state.shockAge - state.age;
  if (idx < 0 || idx >= seq.length) return seq;
  const eraSeq = getHistoricalSequence(era.startYear, Math.min(SHOCK_YEARS, HISTORICAL_END_YEAR - era.startYear + 1), state.stockPct) || [];
  const out = seq.slice();
  for (let j = 0; j < eraSeq.length && idx + j < out.length; j++) out[idx + j] = eraSeq[j];
  return out;
}

// True when `age` falls in [start, end). Null/undefined bounds mean "no window".
function inWindow(age, start, end) {
  return start !== null && start !== undefined && end !== null && end !== undefined && age >= start && age < end;
}

// Planning horizon in years (inclusive of the current age-year). Guarded to at
// least 1: an inverted range (targetAge < age) is reachable from the UI when an
// older user lowers "Plan to age" below their current age. Without the guard the
// run loops produce empty result arrays and summarize() dereferences r[-1] and
// crashes. Clamping to 1 yields a harmless single-year projection instead.
function horizonYears(state) { return Math.max(1, state.targetAge - state.age + 1); }

function simulateOnce(state, returnSeries) {
  const years = [];
  let portfolio = state.portfolio;
  let yourSalary = state.yourIncome;
  let partnerSalary = state.partnerIncome;
  const mortgagePayoffAge = state.mortgagePayoffAge;
  const fee = state.feeRate || 0;
  const band = (state.guardrailBandPct === undefined || state.guardrailBandPct === null) ? 0.20 : state.guardrailBandPct;
  const retRate = retirementTaxRate(state);
  let broken = false;
  let flexCutCount = 0, flexBoostCount = 0;
  let refWithdrawRate = null; // set on first withdrawal year; guardrails compare against this

  // Per-account tracking (only if enabled)
  const useAccts = state.accountsEnabled;
  let accts = useAccts
    ? { traditional: state.accounts.traditional, roth: state.accounts.roth, taxable: state.accounts.taxable }
    : null;
  if (useAccts) {
    portfolio = accts.traditional + accts.roth + accts.taxable;
  }

  for (let i = 0; i < horizonYears(state); i++) {
    const age = state.age + i;
    const partnerAge = state.partnerAge + i;
    const year = CURRENT_YEAR + i;

    if (broken) {
      years.push({ year, age, partnerAge, portfolioStart: 0, portfolio: 0, yourIncome: 0, partnerIncome: 0, ssIncome: 0, spending: 0, withdrawal: 0, housing: 0, tax: 0, marketReturn: 0, flexed: false, ranOut: true });
      continue;
    }

    // Career breaks: no wages between the break start age and the back-to-work age.
    const yourBreak = inWindow(age, state.yourBreakStart, state.yourBreakEnd);
    const partnerBreak = inWindow(partnerAge, state.partnerBreakStart, state.partnerBreakEnd);
    let yourIncomeThisYear = (age >= state.yourStopWorkAge || yourBreak) ? 0 : yourSalary;
    let partnerIncomeThisYear = (!state.hasPartner || partnerAge >= state.partnerStopWorkAge || partnerBreak) ? 0 : partnerSalary;

    if (state.yourPartTimeAmount > 0 && age >= state.yourPartTimeStart && age < state.yourPartTimeEnd) yourIncomeThisYear += state.yourPartTimeAmount;
    if (state.partnerPartTimeAmount > 0 && partnerAge >= state.partnerPartTimeStart && partnerAge < state.partnerPartTimeEnd) partnerIncomeThisYear += state.partnerPartTimeAmount;

    let ssIncome = 0;
    if (age >= state.ssStartAge) ssIncome += state.yourSSAmount;
    if (state.hasPartner && partnerAge >= state.ssStartAge) ssIncome += state.partnerSSAmount;

    const housing = age < mortgagePayoffAge ? state.housing : 0;

    let spend = age >= state.slowDownAge ? state.lateSpending : state.spending;
    const contribPaused = state.contributions > 0 && inWindow(age, state.contribPauseStart, state.contribPauseEnd);

    // Compute income first (independent of spend). Wages carry the wage rate (which
    // includes payroll tax); Social Security is taxed at half the retirement rate as a
    // stand-in for the 0/50/85% inclusion rules.
    const grossIncome = yourIncomeThisYear + partnerIncomeThisYear + ssIncome;
    const taxedIncome = (yourIncomeThisYear + partnerIncomeThisYear) * state.taxRate + ssIncome * (retRate * 0.5);
    const netIncome = grossIncome - taxedIncome;

    // How much of a working year's surplus gets invested. Blank contributions (0) means
    // everything not spent goes into the portfolio. A stated amount means exactly that much
    // is invested and the rest of take-home is treated as spent (lifestyle, cash); while
    // the contributions are paused, none of it is invested.
    let unallocated = 0;
    const wagesThisYear = yourIncomeThisYear + partnerIncomeThisYear;
    if (state.contributions > 0 && wagesThisYear > 0) {
      const target = contribPaused ? 0 : state.contributions;
      const surplus = netIncome - spend - housing;
      if (surplus > target) { unallocated = surplus - target; spend += unallocated; }
    }

    // One-time events + home sale inflows/outflows
    let eventAdj = 0;
    if (state.oneTimeEvents && state.oneTimeEvents.length) {
      for (const ev of state.oneTimeEvents) { if (ev.age === age && ev.amount) eventAdj += ev.amount; }
    }
    if (state.homeSaleAge && age === state.homeSaleAge) eventAdj += state.homeSaleProceeds;

    // Provisional portfolio withdrawal need at base spend
    let provisionalNeed = (spend + housing) - netIncome - eventAdj;

    // Withdrawal-rate guardrails (Guyton-style): cut when drawing too hard, boost when
    // genuinely flush. The reference rate is the withdrawal rate in the first year the
    // household draws on the portfolio with NO wage income (i.e. the initial retirement
    // withdrawal rate). Years with a small top-up draw while still working do not set
    // the reference and are not flexed, otherwise a tiny pre-retirement draw would make
    // every retired year look "stressed" and trigger permanent cuts.
    // KNOWN LIMITATION: if Social Security starts later, the reference year is a "bridge"
    // year with a higher rate, which biases toward boosts once SS begins.
    // Cuts/boosts apply to this year's base spend only; they do not compound.
    let flexed = false;
    // "Retired" = no more wages expected: past your stop-work age (or no wage income at all),
    // and the same for your partner. A career break before that is not retirement, so it
    // neither sets the reference nor gets flexed.
    const retired = wagesThisYear <= 0 && (state.yourIncome <= 0 || age >= state.yourStopWorkAge) && (!state.hasPartner || state.partnerIncome <= 0 || partnerAge >= state.partnerStopWorkAge);
    if (state.guardrailsEnabled && provisionalNeed > 0 && portfolio > 0 && retired) {
      const rate = provisionalNeed / portfolio;
      if (refWithdrawRate === null) {
        refWithdrawRate = rate; // first retired withdrawal year sets the reference
      } else {
        if (rate > refWithdrawRate * (1 + band)) {
          spend = spend * (1 - state.guardrailCutPct);
          flexed = true; flexCutCount++;
        } else if (rate < refWithdrawRate * (1 - band)) {
          spend = spend * (1 + state.guardrailBoostPct);
          flexed = true; flexBoostCount++;
        }
      }
    }

    const totalSpend = spend + housing;
    let netNeed = totalSpend - netIncome - eventAdj;

    let withdrawal = 0;
    let taxThisYear = 0;

    if (netNeed > 0) {
      if (useAccts) {
        const res = withdrawWithTax(netNeed, accts, state.withdrawalStrategy, age, state);
        withdrawal = res.gross;
        taxThisYear = res.tax;
        accts.traditional = Math.max(0, accts.traditional - res.drawn.traditional);
        accts.roth = Math.max(0, accts.roth - res.drawn.roth);
        accts.taxable = Math.max(0, accts.taxable - res.drawn.taxable);
      } else {
        // Single-pool portfolio: every withdrawal is grossed up by the withdrawal tax
        // rate (capGainsTax). This is a visible, editable assumption in the UI.
        withdrawal = netNeed / (1 - state.capGainsTax);
        taxThisYear = withdrawal - netNeed;
      }
    } else {
      // Surplus: add to portfolio (and to taxable account if tracking)
      withdrawal = netNeed; // negative
      if (useAccts) accts.taxable += -netNeed;
    }

    const portfolioStart = portfolio;
    portfolio -= withdrawal;

    // Withdraw at the start of the year, then earn the year's return net of fees.
    const marketReturn = returnSeries[i] !== undefined ? returnSeries[i] : state.returnRate;
    const growth = 1 + marketReturn - fee;
    portfolio = portfolio * growth;
    if (useAccts) {
      accts.traditional *= growth;
      accts.roth *= growth;
      accts.taxable *= growth;
    }

    let ranOutThisYear = false;
    if (portfolio <= 0) { portfolio = 0; ranOutThisYear = true; broken = true; if (useAccts) { accts.traditional = accts.roth = accts.taxable = 0; } }

    years.push({ year, age, partnerAge, portfolioStart, portfolio, yourIncome: yourIncomeThisYear, partnerIncome: partnerIncomeThisYear, ssIncome, spending: totalSpend, withdrawal, housing, tax: taxThisYear, marketReturn, flexed, onBreak: yourBreak || partnerBreak, contribPaused, unallocated, ranOut: ranOutThisYear || broken });

    // Real wage growth applies only in years actually worked (no raises during a break).
    if (!yourBreak) yourSalary *= (1 + (state.yourIncomeGrowth || 0));
    if (!partnerBreak) partnerSalary *= (1 + (state.partnerIncomeGrowth || 0));
  }
  years.flexCutCount = flexCutCount;
  years.flexBoostCount = flexBoostCount;
  years.finalAccounts = useAccts ? { traditional: accts.traditional, roth: accts.roth, taxable: accts.taxable } : null;
  return years;
}

// Seeded PRNG (mulberry32): same seed => same simulated futures, so results do not
// jitter between renders and tests are exact. Returns a function yielding [0,1).
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randNormal(mean, stdDev, rng) {
  const r = rng || Math.random;
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * stdDev + mean;
}

function pctOf(sortedVals, p) { return sortedVals[Math.min(sortedVals.length - 1, Math.floor(sortedVals.length * p))]; }

function buildPercentiles(allRuns, yearCount) {
  const percentiles = [];
  for (let y = 0; y < yearCount; y++) {
    const vals = allRuns.map(r => r[y].portfolio).sort((a, b) => a - b);
    percentiles.push({
      year: allRuns[0][y].year, age: allRuns[0][y].age,
      p10: pctOf(vals, 0.10), p25: pctOf(vals, 0.25), p50: pctOf(vals, 0.50),
      p75: pctOf(vals, 0.75), p90: pctOf(vals, 0.90),
      ranOutPct: allRuns.filter(r => r[y].ranOut).length / allRuns.length,
    });
  }
  return percentiles;
}

function summarize(allRuns, yearCount, mode, labels, extra) {
  const percentiles = buildPercentiles(allRuns, yearCount);
  const finalsWithIdx = allRuns.map((r, i) => ({ v: r[r.length - 1].portfolio, i })).sort((a, b) => a.v - b.v);
  const successCount = allRuns.filter(r => r[r.length - 1].portfolio > 0).length;
  const total = allRuns.length;
  const medianFinal = finalsWithIdx[Math.floor(total / 2)].v;
  // medianRunOutAge is the median depletion age AMONG THE RUNS THAT FAILED. It is not the
  // median outcome; a 94%-success plan still has a value here. Callers must label it so.
  const runOutAges = allRuns.map(r => { const f = r.find(y => y.ranOut); return f ? f.age : null; }).filter(x => x !== null).sort((a, b) => a - b);
  const medianRunOutAge = runOutAges.length ? runOutAges[Math.floor(runOutAges.length / 2)] : null;
  const failures = [];
  allRuns.forEach((run, i) => { const f = run.find(y => y.ranOut); if (f) failures.push({ label: labels ? labels[i] : String(i), ranOutAge: f.age }); });
  failures.sort((a, b) => a.ranOutAge - b.ranOutAge);
  // medianRun = the run whose ending balance is the median (p50) ending balance, so the
  // cashflow chart and tooltips describe a path that actually matches the headline.
  const medianRun = allRuns[finalsWithIdx[Math.floor(total / 2)].i];
  const flexCutYears = medianRun.flexCutCount || 0;
  return Object.assign({
    percentiles, successRate: successCount / total, successCount, totalPeriods: total,
    failureCount: total - successCount, medianFinal, medianRunOutAge, failures, medianRun,
    medianRunFlexCuts: flexCutYears, mode,
  }, extra || {});
}

// Monte Carlo parameters: by default the average and volatility of the chosen historical
// blend (arithmetic mean and sample sd of the annual real returns), so "Simulated" and
// "Historical" describe the same portfolio. Either can be overridden in state.
function mcParams(state) {
  const h = historicalStats(state.stockPct);
  const mean = (state.mcMean === null || state.mcMean === undefined) ? h.mean : state.mcMean;
  const sd = (state.mcSd === null || state.mcSd === undefined) ? h.sd : state.mcSd;
  return { mean, sd, fromHistory: (state.mcMean === null || state.mcMean === undefined) && (state.mcSd === null || state.mcSd === undefined) };
}

function runMonteCarlo(state, numSims) {
  const sims = numSims || state.mcSims || 500;
  const yearCount = horizonYears(state);
  const { mean, sd } = mcParams(state);
  const rng = makeRng(state.mcSeed === undefined || state.mcSeed === null ? 12345 : state.mcSeed);
  const allRuns = [];
  for (let s = 0; s < sims; s++) {
    const seq = [];
    for (let y = 0; y < yearCount; y++) seq.push(randNormal(mean, sd, rng));
    allRuns.push(simulateOnce(state, applyShock(seq, state)));
  }
  return summarize(allRuns, yearCount, 'montecarlo', null, { mcMean: mean, mcSd: sd, mcSims: sims, mcSeed: state.mcSeed });
}

function runHistorical(state) {
  const yearCount = horizonYears(state);
  const series = blendSeries(state.stockPct);
  const geo = seriesStats(series).geo;
  const maxStart = HISTORICAL_END_YEAR - yearCount + 1;
  const allRuns = []; const labels = [];
  let paddedYears = 0;
  for (let sy = HISTORICAL_START_YEAR; sy <= maxStart; sy++) {
    const seq = getHistoricalSequence(sy, yearCount, state.stockPct);
    if (!seq) continue;
    allRuns.push(simulateOnce(state, applyShock(seq, state)));
    labels.push(sy + '–' + (sy + yearCount - 1));
  }
  // If the horizon is longer than the data, fall back to windows padded with the
  // blend's long-run compound (geometric) return. Labelled with * so the UI can say so.
  if (allRuns.length === 0) {
    for (let sy = HISTORICAL_START_YEAR; sy <= HISTORICAL_END_YEAR - 10; sy++) {
      const avail = getHistoricalSequence(sy, HISTORICAL_END_YEAR - sy + 1, state.stockPct);
      const seq = [...avail]; while (seq.length < yearCount) seq.push(geo);
      paddedYears = Math.max(paddedYears, yearCount - avail.length);
      allRuns.push(simulateOnce(state, applyShock(seq, state)));
      labels.push(sy + '–' + (sy + yearCount - 1) + '*');
    }
  }
  const firstStart = HISTORICAL_START_YEAR;
  const lastStart = paddedYears ? HISTORICAL_END_YEAR - 10 : maxStart;
  return summarize(allRuns, yearCount, 'historical', labels, { windows: { count: allRuns.length, firstStart, lastStart, years: yearCount, paddedYears } });
}

function runFixed(state) {
  const yearCount = horizonYears(state);
  const seq = applyShock(new Array(yearCount).fill(state.returnRate), state);
  const run = simulateOnce(state, seq);
  const finalBal = run[run.length - 1].portfolio;
  const runOut = run.find(y => y.ranOut);
  return {
    percentiles: run.map(y => ({ year: y.year, age: y.age, p10: y.portfolio, p25: y.portfolio, p50: y.portfolio, p75: y.portfolio, p90: y.portfolio, ranOutPct: y.ranOut ? 1 : 0 })),
    successRate: finalBal > 0 ? 1 : 0, successCount: finalBal > 0 ? 1 : 0, totalPeriods: 1, failureCount: finalBal > 0 ? 0 : 1,
    medianFinal: finalBal, medianRunOutAge: runOut ? runOut.age : null, failures: runOut ? [{ label: 'fixed', ranOutAge: runOut.age }] : [],
    medianRun: run, medianRunFlexCuts: run.flexCutCount || 0, mode: 'fixed',
  };
}

function runForState(s) {
  // Merge with defaults so any missing fields (e.g. targetAge) get filled in
  const merged = Object.assign({}, DEFAULT_STATE, s);
  return merged.simMode === 'historical' ? runHistorical(merged) : merged.simMode === 'montecarlo' ? runMonteCarlo(merged) : runFixed(merged);
}

function runNamedScenario(state, scenario) {
  const yearCount = horizonYears(state);
  let seq = getHistoricalSequence(scenario.startYear, yearCount, state.stockPct);
  let padded = false, paddedYears = 0;
  if (!seq) {
    const avail = getHistoricalSequence(scenario.startYear, HISTORICAL_END_YEAR - scenario.startYear + 1, state.stockPct) || [];
    const geo = historicalStats(state.stockPct).geo;
    seq = [...avail]; while (seq.length < yearCount) seq.push(geo);
    padded = true; paddedYears = yearCount - avail.length;
  }
  return { years: simulateOnce(state, seq), scenario, padded, paddedYears };
}

// Max spend at a STEADY return (Fixed mode): highest spend landing at the end-goal
// buffer. Binary-searches spending in [$5k, $600k]. NOTE the bounds are artifacts: if
// even $5k/yr fails (tiny portfolio) it still returns $5k as "max" (a floor, not a
// sustainable figure), and very large portfolios are capped at $600k. This figure has no
// sequence-of-returns risk in it; see findMaxSpendAtSuccess for the historical version.
function findMaxSpend(state) {
  const buffer = state.endGoalBuffer || 0;
  let low = 5000, high = 600000, best = low, bestFinal = null;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    const ratio = state.spending > 0 ? (state.lateSpending / state.spending) : 1;
    const r = runFixed({ ...state, spending: mid, lateSpending: mid * ratio, guardrailsEnabled: false });
    if (r.medianRunOutAge === null && r.medianFinal >= buffer) { best = mid; bestFinal = r.medianFinal; low = mid; }
    else high = mid;
  }
  return { spend: best, medianFinal: bestFinal };
}

// Max spend that survived at least `threshold` of historical periods (default: the
// state's successThreshold, 85%), guardrails off so the figure is a true steady-spending
// ceiling. Deterministic. Same [$5k, $600k] bounds and caveats as findMaxSpend.
function findMaxSpendAtSuccess(state, threshold) {
  const th = threshold === undefined ? (state.successThreshold || 0.85) : threshold;
  const base = Object.assign({}, DEFAULT_STATE, state, { simMode: 'historical', guardrailsEnabled: false });
  const ratio = base.spending > 0 ? (base.lateSpending / base.spending) : 1;
  let low = 5000, high = 600000, best = low, bestResult = null;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    const r = runHistorical({ ...base, spending: mid, lateSpending: mid * ratio });
    if (r.successRate >= th) { best = mid; bestResult = r; low = mid; }
    else high = mid;
  }
  if (!bestResult) bestResult = runHistorical({ ...base, spending: best, lateSpending: best * ratio });
  return { spend: best, successRate: bestResult.successRate, successCount: bestResult.successCount, totalPeriods: bestResult.totalPeriods, threshold: th };
}

// ============================================================================
// TAX & SOCIAL SECURITY ESTIMATORS (approximations; for the helper modals)
// ============================================================================
const FED_BRACKETS_2026 = {
  single: [[0,0.10],[12400,0.12],[50400,0.22],[105700,0.24],[201775,0.32],[256225,0.35],[640600,0.37]],
  mfj: [[0,0.10],[24800,0.12],[100800,0.22],[211400,0.24],[403550,0.32],[512450,0.35],[768700,0.37]],
};
const FED_STANDARD_DEDUCTION_2026 = { single: 16100, mfj: 32200 };
const CA_BRACKETS_2025 = {
  single: [[0,0.01],[10756,0.02],[25499,0.04],[40245,0.06],[55866,0.08],[70606,0.093],[360659,0.103],[432787,0.113],[721314,0.123]],
  mfj: [[0,0.01],[21512,0.02],[50998,0.04],[80490,0.06],[111732,0.08],[141212,0.093],[721318,0.103],[865574,0.113],[1442628,0.123]],
};
const CA_STANDARD_DEDUCTION_2025 = { single: 5706, mfj: 11412 };
const CA_MENTAL_HEALTH_THRESHOLD = 1000000;
const SS_WAGE_BASE_2026 = 184500, MEDICARE_RATE = 0.0145, SS_RATE = 0.062, ADD_MEDICARE_RATE = 0.009;
const ADD_MEDICARE_THRESHOLD = { single: 200000, mfj: 250000 };
// State tax rates: CA full brackets from CA FTB 2025 (ftb.ca.gov). No-tax states from SSA/IRS records.
// Flat/graduated approximations sourced from Tax Foundation state income tax rates (taxfoundation.org/data/all/state/state-income-tax-rates/)
// and individual state revenue departments. Rates reflect 2025 statutory or typical effective rates.
const STATE_CONFIG = {
  // Full brackets
  CA: { name: 'California', brackets: CA_BRACKETS_2025, standardDeduction: CA_STANDARD_DEDUCTION_2025, mentalHealthSurcharge: true },
  // No state income tax
  AK: { name: 'Alaska', flatApprox: 0 },
  FL: { name: 'Florida', flatApprox: 0 },
  NV: { name: 'Nevada', flatApprox: 0 },
  NH: { name: 'New Hampshire', flatApprox: 0 },
  SD: { name: 'South Dakota', flatApprox: 0 },
  TN: { name: 'Tennessee', flatApprox: 0 },
  TX: { name: 'Texas', flatApprox: 0 },
  WA: { name: 'Washington', flatApprox: 0 },
  WY: { name: 'Wyoming', flatApprox: 0 },
  // Flat-rate states (statutory rate)
  AZ: { name: 'Arizona', flatApprox: 0.025 },
  CO: { name: 'Colorado', flatApprox: 0.044 },
  GA: { name: 'Georgia', flatApprox: 0.054 },
  ID: { name: 'Idaho', flatApprox: 0.058 },
  IL: { name: 'Illinois', flatApprox: 0.0495 },
  IN: { name: 'Indiana', flatApprox: 0.04 },    // state 3.05% + avg county ~1%
  IA: { name: 'Iowa', flatApprox: 0.038 },
  KY: { name: 'Kentucky', flatApprox: 0.04 },
  LA: { name: 'Louisiana', flatApprox: 0.03 },  // 3% flat as of 2025
  MA: { name: 'Massachusetts', flatApprox: 0.05 },
  MI: { name: 'Michigan', flatApprox: 0.0425 }, // state 4.05% + avg local ~0.2%
  MS: { name: 'Mississippi', flatApprox: 0.047 },
  NC: { name: 'North Carolina', flatApprox: 0.045 },
  PA: { name: 'Pennsylvania', flatApprox: 0.0307 },
  UT: { name: 'Utah', flatApprox: 0.0455 },
  // Graduated states (flat approximation of typical effective rate)
  AL: { name: 'Alabama', flatApprox: 0.04 },
  AR: { name: 'Arkansas', flatApprox: 0.04 },
  CT: { name: 'Connecticut', flatApprox: 0.055 },
  DC: { name: 'District of Columbia', flatApprox: 0.07 },
  DE: { name: 'Delaware', flatApprox: 0.05 },
  HI: { name: 'Hawaii', flatApprox: 0.07 },
  KS: { name: 'Kansas', flatApprox: 0.045 },
  ME: { name: 'Maine', flatApprox: 0.055 },
  MD: { name: 'Maryland', flatApprox: 0.065 }, // state ~5.75% + avg county ~3%
  MN: { name: 'Minnesota', flatApprox: 0.065 },
  MO: { name: 'Missouri', flatApprox: 0.04 },
  MT: { name: 'Montana', flatApprox: 0.059 },
  NE: { name: 'Nebraska', flatApprox: 0.045 },
  NJ: { name: 'New Jersey', flatApprox: 0.06 },
  NM: { name: 'New Mexico', flatApprox: 0.045 },
  NY: { name: 'New York', flatApprox: 0.065 },  // state ~6.85% + NYC ~3.9% for city residents; ~6.5% outside NYC
  ND: { name: 'North Dakota', flatApprox: 0.02 },
  OH: { name: 'Ohio', flatApprox: 0.035 },      // state up to 3.99% + avg local ~1.5%
  OK: { name: 'Oklahoma', flatApprox: 0.04 },
  OR: { name: 'Oregon', flatApprox: 0.07 },
  RI: { name: 'Rhode Island', flatApprox: 0.05 },
  SC: { name: 'South Carolina', flatApprox: 0.05 },
  VT: { name: 'Vermont', flatApprox: 0.06 },
  VA: { name: 'Virginia', flatApprox: 0.05 },
  WV: { name: 'West Virginia', flatApprox: 0.04 },
  WI: { name: 'Wisconsin', flatApprox: 0.055 },
};
function taxFromBrackets(taxable, brackets) {
  if (taxable <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [lower, rate] = brackets[i];
    const upper = i < brackets.length - 1 ? brackets[i + 1][0] : Infinity;
    if (taxable > lower) tax += (Math.min(taxable, upper) - lower) * rate; else break;
  }
  return tax;
}
// Returns federal, state, and FICA on gross wages. `incomeTaxRate` (federal + state only,
// no payroll tax) is the right rate for retirement withdrawals; `effectiveRate` includes
// FICA and is the right rate for wages.
function estimateNetIncome({ gross, filingStatus = 'mfj', stateCode = 'CA', pretax = 0 }) {
  if (gross <= 0) return { net: 0, federal: 0, state: 0, fica: 0, totalTax: 0, effectiveRate: 0, incomeTaxRate: 0 };
  const w = Math.max(0, gross - pretax);
  const federal = taxFromBrackets(Math.max(0, w - FED_STANDARD_DEDUCTION_2026[filingStatus]), FED_BRACKETS_2026[filingStatus]);
  const sc = STATE_CONFIG[stateCode] || { flatApprox: 0.05 };
  let stateTax = 0;
  if (sc.brackets) {
    const st = Math.max(0, w - sc.standardDeduction[filingStatus]);
    stateTax = taxFromBrackets(st, sc.brackets[filingStatus]);
    if (sc.mentalHealthSurcharge && st > CA_MENTAL_HEALTH_THRESHOLD) stateTax += (st - CA_MENTAL_HEALTH_THRESHOLD) * 0.01;
  } else stateTax = w * (sc.flatApprox || 0);
  // NOTE: FICA here is computed on w = gross - pretax. Strictly, traditional 401(k)/pretax
  // deferrals are exempt from income tax but NOT from Social Security/Medicare (FICA) tax,
  // so this slightly understates FICA when pretax > 0. Latent today (every caller passes
  // pretax = 0); if pretax is ever wired up, base FICA on gross wages instead of w.
  const fica = Math.min(w, SS_WAGE_BASE_2026) * SS_RATE + w * MEDICARE_RATE + Math.max(0, w - ADD_MEDICARE_THRESHOLD[filingStatus]) * ADD_MEDICARE_RATE;
  const totalTax = federal + stateTax + fica;
  return { net: gross - totalTax - pretax, federal: Math.round(federal), state: Math.round(stateTax), fica: Math.round(fica), totalTax: Math.round(totalTax), effectiveRate: totalTax / gross, incomeTaxRate: (federal + stateTax) / gross };
}
function estimateSSBenefit(annualGross) {
  if (annualGross <= 0) return 0;
  // SIMPLIFICATION: real AIME is the average of the highest 35 years of wage-indexed
  // earnings, divided by 12. Here we use a single year's income as the monthly AIME,
  // which overstates the benefit (~10% for high earners, ~20-25% for typical earners)
  // versus an actual ssa.gov statement. The helper UI labels this a rough estimate and
  // points users to ssa.gov for the authoritative figure. Bend points verified for 2026.
  const aime = Math.min(annualGross, SS_WAGE_BASE_2026) / 12;
  const bend1 = 1286, bend2 = 7749;
  let pia;
  if (aime <= bend1) pia = aime * 0.9;
  else if (aime <= bend2) pia = bend1 * 0.9 + (aime - bend1) * 0.32;
  else pia = bend1 * 0.9 + (bend2 - bend1) * 0.32 + (aime - bend2) * 0.15;
  return Math.round(pia * 12);
}

// ============================================================================
// STATE
// ============================================================================
// Every default here is shown to the user in the app's Assumptions panel. Fields marked
// (null) mean "derive from the data/estimator" until the user overrides them.
const DEFAULT_STATE = {
  age: 0, partnerAge: 0, hasPartner: false,
  portfolio: 0,
  spending: 0, lateSpending: 0, slowDownAge: 75,
  housing: 0, mortgagePayoffAge: 60, mortgageBalance: 0, mortgageRate: 0,
  yourIncome: 0, yourStopWorkAge: 65, yourIncomeGrowth: 0.01,
  partnerIncome: 0, partnerStopWorkAge: 65, partnerIncomeGrowth: 0.01,
  yourPartTimeAmount: 0, yourPartTimeStart: 65, yourPartTimeEnd: 70,
  partnerPartTimeAmount: 0, partnerPartTimeStart: 65, partnerPartTimeEnd: 70,
  // Career breaks (no wages from start age until the back-to-work age; null = none).
  // contributions = how much of take-home is invested each year while working (0 = all of
  // what is not spent); the rest is treated as spent. The pause window invests nothing.
  yourBreakStart: null, yourBreakEnd: null, partnerBreakStart: null, partnerBreakEnd: null,
  contributions: 0, contribPauseStart: null, contribPauseEnd: null,
  // Market shock: id from HISTORICAL_SCENARIOS whose first ten years replace the returns
  // from shockAge onward (null = none).
  shockEra: null, shockAge: null,
  ssStartAge: 67, yourSSAmount: 0, partnerSSAmount: 0,
  oneTimeEvents: [], homeSaleAge: null, homeSaleProceeds: 0,
  // Portfolio: share in stocks (rest in 10-year Treasuries), annual fee drag
  // (0.10% = a typical low-cost index fund; owner-chosen default, editable in the app).
  stockPct: 0.6, feeRate: 0.001,
  // Fixed mode: one steady real return. Monte Carlo: mean/sd default to the chosen
  // blend's historical average and volatility (null = follow the data); seed fixed.
  returnRate: 0.05, returnStdDev: 0.15,
  mcMean: null, mcSd: null, mcSims: 500, mcSeed: 12345,
  // taxRate = rate on wages (includes payroll tax); retirementTaxRate = rate on
  // traditional-IRA withdrawals and half of Social Security (null = same as taxRate);
  // capGainsTax = gross-up applied to every withdrawal when accounts are not tracked.
  taxRate: 0.18, retirementTaxRate: null, capGainsTax: 0.15,
  filingStatus: 'mfj', stateCode: 'CA',
  simMode: 'fixed',
  targetAge: 100,
  successThreshold: 0.85, endGoalBuffer: 0,
  // Spending flexibility (percentage-based guardrails, Guyton-style).
  guardrailsEnabled: true, guardrailCutPct: 0.25, guardrailBoostPct: 0.20, guardrailBandPct: 0.20,
  // Account types
  accountsEnabled: false,
  accounts: { traditional: 0, roth: 0, taxable: 0 },
  withdrawalStrategy: 'taxSmart',
};

const SAMPLE_STATE = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), {
  age: 52, partnerAge: 50, hasPartner: true,
  portfolio: 700000, spending: 80000, lateSpending: 65000, slowDownAge: 75,
  housing: 24000, mortgagePayoffAge: 62,
  yourIncome: 120000, yourStopWorkAge: 62,
  partnerIncome: 0, partnerStopWorkAge: 60,
  ssStartAge: 67, yourSSAmount: 30000, partnerSSAmount: 18000,
  simMode: 'historical',
  accountsEnabled: true, accounts: { traditional: 280000, roth: 150000, taxable: 270000 },
});

  return { CURRENT_YEAR, HISTORICAL_START_YEAR, HISTORICAL_END_YEAR, HISTORICAL_PARTIAL_YEARS, STOCK_RETURNS, BOND_RETURNS, HISTORICAL_RETURNS, DATA_SOURCE, blendSeries, getHistoricalSequence, seriesStats, historicalStats, HISTORICAL_SCENARIOS, SHOCK_YEARS, applyShock, inWindow, retirementTaxRate, withdrawWithTax, simulateOnce, makeRng, randNormal, pctOf, buildPercentiles, summarize, mcParams, runMonteCarlo, runHistorical, runFixed, runForState, runNamedScenario, findMaxSpend, findMaxSpendAtSuccess, FED_BRACKETS_2026, FED_STANDARD_DEDUCTION_2026, CA_BRACKETS_2025, CA_STANDARD_DEDUCTION_2025, CA_MENTAL_HEALTH_THRESHOLD, SS_WAGE_BASE_2026, MEDICARE_RATE, SS_RATE, ADD_MEDICARE_RATE, ADD_MEDICARE_THRESHOLD, STATE_CONFIG, taxFromBrackets, estimateNetIncome, estimateSSBenefit, DEFAULT_STATE, SAMPLE_STATE };
});
