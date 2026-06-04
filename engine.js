/* ============================================================================
   FINANCIAL PLANNER — SIMULATION ENGINE  (engine.js)
   ----------------------------------------------------------------------------
   Pure, DOM-free simulation + estimator code. Loaded by index.html via
   <script src="engine.js"> (attaches all symbols to window) and by tests.js
   via require() in Node. NO DOM, NO build step — plain ES2017.

   Contents:
     1. CONSTANTS & HISTORICAL DATA ... HISTORICAL_RETURNS, HISTORICAL_SCENARIOS
     2. SIMULATION ENGINE ............. withdrawWithTax, simulateOnce,
                                        runFixed/runHistorical/runMonteCarlo,
                                        runForState, runNamedScenario, findMaxSpend
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

// S&P 500 annual REAL (inflation-adjusted) total returns, dividends reinvested.
// Source: us500.com / Shiller CPI series, 1926-2025. Stored as decimals.
const HISTORICAL_START_YEAR = 1926;
const HISTORICAL_RETURNS = [
  0.1288,0.4067,0.453,-0.0895,-0.1976,-0.3752,0.0232,0.5283,-0.0292,0.4338,
  0.3201,-0.3684,0.3487,-0.0041,-0.1042,-0.1958,0.1037,0.2228,0.1706,0.3344,
  -0.2218,-0.0288,0.0244,0.213,0.2434,0.17,0.1749,-0.0173,0.5376,0.3108,
  0.0347,-0.1329,0.4088,0.1006,-0.0088,0.2605,-0.0993,0.2082,0.1536,0.1033,
  -0.1307,0.2032,0.0605,-0.1384,-0.0148,0.1069,0.1506,-0.215,-0.3455,0.283,
  0.181,-0.1301,-0.0226,0.0455,0.1769,-0.127,0.1707,0.1808,0.0223,0.2691,
  0.1738,0.0079,0.1167,0.2584,-0.0868,0.266,0.0459,0.0713,-0.0131,0.3417,
  0.1901,0.3113,0.2654,0.1788,-0.1208,-0.1323,-0.2391,0.2631,0.0738,0.0144,
  0.1292,0.0137,-0.3707,0.2311,0.1336,-0.0083,0.1402,0.3043,0.1283,0.0065,
  0.0969,0.1931,-0.0617,0.2855,0.1681,0.2024,-0.2307,0.222,0.2151,0.148
];

const HISTORICAL_END_YEAR = HISTORICAL_START_YEAR + HISTORICAL_RETURNS.length - 1;

function getHistoricalSequence(startYear, numYears) {
  const startIdx = startYear - HISTORICAL_START_YEAR;
  if (startIdx < 0 || startIdx + numYears > HISTORICAL_RETURNS.length) return null;
  return HISTORICAL_RETURNS.slice(startIdx, startIdx + numYears);
}

const AVG_HISTORICAL_RETURN = HISTORICAL_RETURNS.reduce((a, b) => a + b, 0) / HISTORICAL_RETURNS.length;

// Named historical scenarios for stress tests
const HISTORICAL_SCENARIOS = [
  { id: 'depression', name: 'Great Depression', startYear: 1929, description: 'Markets lost most of their real value over three years; deflation followed.' },
  { id: 'postwar', name: 'Post-war boom', startYear: 1950, description: 'Strong growth and rising wages through the 1950s and 60s.' },
  { id: 'stagflation', name: '1970s stagflation', startYear: 1969, description: 'High inflation and oil shocks; real returns were negative for a decade.' },
  { id: 'reagan', name: '1980s bull market', startYear: 1982, description: 'Falling interest rates fueled a long equity rally.' },
  { id: 'dotcom', name: 'Dot-com to 2008', startYear: 2000, description: 'Two major crashes within a decade — a hard sequence for retirees.' },
];

// ============================================================================
// SIMULATION ENGINE
// ============================================================================

function withdrawWithTax(netNeed, accts, strategy, age, state) {
  // Returns { gross, tax, drawn: {traditional, roth, taxable} }
  // netNeed is the after-tax cash required from the portfolio.
  // We gross up per account so that (gross - tax) covers netNeed.
  const penalty = age < 59.5 ? 0.10 : 0;
  const effRate = {
    traditional: Math.min(0.95, state.taxRate + penalty),
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
  let broken = false;
  let flexCutCount = 0;
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

    let yourIncomeThisYear = age >= state.yourStopWorkAge ? 0 : yourSalary;
    let partnerIncomeThisYear = (state.hasPartner && partnerAge >= state.partnerStopWorkAge) ? 0 : (state.hasPartner ? partnerSalary : 0);

    if (state.yourPartTimeAmount > 0 && age >= state.yourPartTimeStart && age < state.yourPartTimeEnd) yourIncomeThisYear += state.yourPartTimeAmount;
    if (state.partnerPartTimeAmount > 0 && partnerAge >= state.partnerPartTimeStart && partnerAge < state.partnerPartTimeEnd) partnerIncomeThisYear += state.partnerPartTimeAmount;

    let ssIncome = 0;
    if (age >= state.ssStartAge) ssIncome += state.yourSSAmount;
    if (state.hasPartner && partnerAge >= state.ssStartAge) ssIncome += state.partnerSSAmount;

    const housing = age < mortgagePayoffAge ? state.housing : 0;

    let spend = age >= state.slowDownAge ? state.lateSpending : state.spending;

    // Compute income first (independent of spend)
    const grossIncome = yourIncomeThisYear + partnerIncomeThisYear + ssIncome;
    const taxedIncome = (yourIncomeThisYear + partnerIncomeThisYear) * state.taxRate + ssIncome * (state.taxRate * 0.5);
    const netIncome = grossIncome - taxedIncome;

    // One-time events + home sale inflows/outflows
    let eventAdj = 0;
    if (state.oneTimeEvents && state.oneTimeEvents.length) {
      for (const ev of state.oneTimeEvents) { if (ev.age === age && ev.amount) eventAdj += ev.amount; }
    }
    if (state.homeSaleAge && age === state.homeSaleAge) eventAdj += state.homeSaleProceeds;

    // Provisional portfolio withdrawal need at base spend
    let provisionalNeed = (spend + housing) - netIncome - eventAdj;

    // Withdrawal-rate guardrails: cut when drawing too hard, boost when genuinely flush.
    // Reference rate is set in the first year of meaningful portfolio withdrawal.
    // This ensures cuts fire in stressed sequences and boosts only when there's real surplus.
    // KNOWN LIMITATION: the band is anchored to the FIRST withdrawal year's rate. If that
    // year is unrepresentative (e.g. a "bridge" draw before Social Security starts, or a
    // small transitional draw), the reference can be too high/low — biasing toward
    // persistent boosts once SS begins, or persistent cuts. Fine for the common cases
    // (already-retired, decades-away); revisit if anchoring proves misleading.
    let flexed = false;
    if (state.guardrailsEnabled && provisionalNeed > 0 && portfolio > 0) {
      const rate = provisionalNeed / portfolio;
      if (refWithdrawRate === null) {
        refWithdrawRate = rate; // first withdrawal year sets the reference
      } else {
        const band = 0.20; // ±20% of reference rate as guardrail band
        if (rate > refWithdrawRate * (1 + band)) {
          // Drawing too hard — cut spending
          spend = spend * (1 - state.guardrailCutPct);
          flexed = true; flexCutCount++;
        } else if (rate < refWithdrawRate * (1 - band)) {
          // Genuinely flush — allow boost
          spend = spend * (1 + state.guardrailBoostPct);
          flexed = true;
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

    const realReturn = returnSeries[i] !== undefined ? returnSeries[i] : state.returnRate;
    portfolio = portfolio * (1 + realReturn);
    if (useAccts) {
      accts.traditional *= (1 + realReturn);
      accts.roth *= (1 + realReturn);
      accts.taxable *= (1 + realReturn);
    }

    let ranOutThisYear = false;
    if (portfolio <= 0) { portfolio = 0; ranOutThisYear = true; broken = true; if (useAccts) { accts.traditional = accts.roth = accts.taxable = 0; } }

    years.push({ year, age, partnerAge, portfolioStart, portfolio, yourIncome: yourIncomeThisYear, partnerIncome: partnerIncomeThisYear, ssIncome, spending: totalSpend, withdrawal, housing, tax: taxThisYear, marketReturn: realReturn, flexed, ranOut: ranOutThisYear || broken });

    yourSalary *= (1 + (state.yourIncomeGrowth || 0));
    partnerSalary *= (1 + (state.partnerIncomeGrowth || 0));
  }
  years.flexCutCount = flexCutCount;
  years.finalAccounts = useAccts ? { traditional: accts.traditional, roth: accts.roth, taxable: accts.taxable } : null;
  return years;
}

function randNormal(mean, stdDev) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
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

function summarize(allRuns, yearCount, mode, labels) {
  const percentiles = buildPercentiles(allRuns, yearCount);
  const successCount = allRuns.filter(r => r[r.length - 1].portfolio > 0).length;
  const total = allRuns.length;
  const finals = allRuns.map(r => r[r.length - 1].portfolio).sort((a, b) => a - b);
  const medianFinal = finals[Math.floor(finals.length / 2)];
  const runOutAges = allRuns.map(r => { const f = r.find(y => y.ranOut); return f ? f.age : null; }).filter(x => x !== null).sort((a, b) => a - b);
  const medianRunOutAge = runOutAges.length ? runOutAges[Math.floor(runOutAges.length / 2)] : null;
  const failures = [];
  allRuns.forEach((run, i) => { const f = run.find(y => y.ranOut); if (f) failures.push({ label: labels ? labels[i] : String(i), ranOutAge: f.age }); });
  failures.sort((a, b) => a.ranOutAge - b.ranOutAge);
  // NOTE: medianRun is the middle run BY INDEX (middle start-year for historical, an
  // arbitrary run for Monte Carlo) — NOT the median-outcome path. The chart's median
  // line uses the p50 percentile series; the cashflow chart/tooltip use medianRun, so
  // the two can differ slightly. Kept as-is (a true median path would need a per-year
  // representative run); flagged so callers don't assume medianRun == p50.
  return { percentiles, successRate: successCount / total, successCount, totalPeriods: total, medianFinal, medianRunOutAge, failures, medianRun: allRuns[Math.floor(allRuns.length / 2)], mode };
}

function runMonteCarlo(state, numSims = 500) {
  const yearCount = horizonYears(state);
  const allRuns = [];
  for (let s = 0; s < numSims; s++) {
    const seq = [];
    for (let y = 0; y < yearCount; y++) seq.push(randNormal(state.returnRate, state.returnStdDev));
    allRuns.push(simulateOnce(state, seq));
  }
  return summarize(allRuns, yearCount, 'montecarlo', null);
}

function runHistorical(state) {
  const yearCount = horizonYears(state);
  const maxStart = HISTORICAL_END_YEAR - yearCount + 1;
  const allRuns = []; const labels = [];
  for (let sy = HISTORICAL_START_YEAR; sy <= maxStart; sy++) {
    const seq = getHistoricalSequence(sy, yearCount);
    if (!seq) continue;
    allRuns.push(simulateOnce(state, seq));
    labels.push(sy + '\u2013' + (sy + yearCount - 1));
  }
  // If horizon too long for any full window, fall back to padded windows
  if (allRuns.length === 0) {
    for (let sy = HISTORICAL_START_YEAR; sy <= HISTORICAL_END_YEAR - 10; sy++) {
      const avail = getHistoricalSequence(sy, HISTORICAL_END_YEAR - sy + 1);
      const seq = [...avail]; while (seq.length < yearCount) seq.push(AVG_HISTORICAL_RETURN);
      allRuns.push(simulateOnce(state, seq));
      labels.push(sy + '\u2013' + (sy + yearCount - 1) + '*');
    }
  }
  return summarize(allRuns, yearCount, 'historical', labels);
}

function runFixed(state) {
  const yearCount = horizonYears(state);
  const seq = new Array(yearCount).fill(state.returnRate);
  const run = simulateOnce(state, seq);
  const finalBal = run[run.length - 1].portfolio;
  const runOut = run.find(y => y.ranOut);
  return {
    percentiles: run.map(y => ({ year: y.year, age: y.age, p10: y.portfolio, p25: y.portfolio, p50: y.portfolio, p75: y.portfolio, p90: y.portfolio, ranOutPct: y.ranOut ? 1 : 0 })),
    successRate: finalBal > 0 ? 1 : 0, successCount: finalBal > 0 ? 1 : 0, totalPeriods: 1,
    medianFinal: finalBal, medianRunOutAge: runOut ? runOut.age : null, failures: runOut ? [{ label: 'fixed', ranOutAge: runOut.age }] : [],
    medianRun: run, mode: 'fixed',
  };
}

function runForState(s) {
  // Merge with defaults so any missing fields (e.g. targetAge) get filled in
  const merged = Object.assign({}, DEFAULT_STATE, s);
  return merged.simMode === 'historical' ? runHistorical(merged) : merged.simMode === 'montecarlo' ? runMonteCarlo(merged) : runFixed(merged);
}

function runNamedScenario(state, scenario) {
  const yearCount = horizonYears(state);
  let seq = getHistoricalSequence(scenario.startYear, yearCount);
  let padded = false;
  if (!seq) {
    const avail = getHistoricalSequence(scenario.startYear, HISTORICAL_END_YEAR - scenario.startYear + 1) || [];
    seq = [...avail]; while (seq.length < yearCount) seq.push(AVG_HISTORICAL_RETURN);
    padded = true;
  }
  return { years: simulateOnce(state, seq), scenario, padded };
}

// Max sustainable spend (deterministic): highest spend landing at the end-goal buffer.
// Binary-searches spending in [$5k, $600k]. NOTE the bounds are artifacts: if even $5k/yr
// fails (tiny portfolio) it still returns $5k as "max" (a floor, not a sustainable figure),
// and very large portfolios are capped at $600k. The cap is what keeps this from returning
// implausible millions; widen both bounds if the input range ever needs it.
function findMaxSpend(state) {
  const buffer = state.endGoalBuffer || 0;
  let low = 5000, high = 600000, best = low, bestFinal = null;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    const ratio = state.spending > 0 ? (state.lateSpending / state.spending) : 1;
    const r = runFixed({ ...state, spending: mid, lateSpending: mid * ratio });
    if (r.medianRunOutAge === null && r.medianFinal >= buffer) { best = mid; bestFinal = r.medianFinal; low = mid; }
    else high = mid;
  }
  return { spend: best, medianFinal: bestFinal };
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
const STATE_CONFIG = {
  CA: { name: 'California', brackets: CA_BRACKETS_2025, standardDeduction: CA_STANDARD_DEDUCTION_2025, mentalHealthSurcharge: true },
  NY: { name: 'New York', flatApprox: 0.065 },
  TX: { name: 'Texas (no state tax)', flatApprox: 0 },
  FL: { name: 'Florida (no state tax)', flatApprox: 0 },
  WA: { name: 'Washington (no state tax)', flatApprox: 0 },
  NV: { name: 'Nevada (no state tax)', flatApprox: 0 },
  OTHER: { name: 'Other / approximate', flatApprox: 0.05 },
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
function estimateNetIncome({ gross, filingStatus = 'mfj', stateCode = 'CA', pretax = 0 }) {
  if (gross <= 0) return { net: 0, federal: 0, state: 0, fica: 0, totalTax: 0, effectiveRate: 0 };
  const w = Math.max(0, gross - pretax);
  const federal = taxFromBrackets(Math.max(0, w - FED_STANDARD_DEDUCTION_2026[filingStatus]), FED_BRACKETS_2026[filingStatus]);
  const sc = STATE_CONFIG[stateCode] || STATE_CONFIG.OTHER;
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
  return { net: gross - totalTax - pretax, federal: Math.round(federal), state: Math.round(stateTax), fica: Math.round(fica), totalTax: Math.round(totalTax), effectiveRate: totalTax / gross };
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
const DEFAULT_STATE = {
  age: 0, partnerAge: 0, hasPartner: false,
  portfolio: 0,
  spending: 0, lateSpending: 0, slowDownAge: 75,
  housing: 0, mortgagePayoffAge: 60,
  yourIncome: 0, yourStopWorkAge: 65, yourIncomeGrowth: 0.01,
  partnerIncome: 0, partnerStopWorkAge: 65, partnerIncomeGrowth: 0.01,
  yourPartTimeAmount: 0, yourPartTimeStart: 65, yourPartTimeEnd: 70,
  partnerPartTimeAmount: 0, partnerPartTimeStart: 65, partnerPartTimeEnd: 70,
  ssStartAge: 67, yourSSAmount: 0, partnerSSAmount: 0,
  oneTimeEvents: [], homeSaleAge: null, homeSaleProceeds: 0,
  returnRate: 0.05, returnStdDev: 0.15,
  taxRate: 0.18, capGainsTax: 0.15,
  filingStatus: 'mfj', stateCode: 'OTHER',
  simMode: 'fixed',
  targetAge: 100,
  successThreshold: 0.85, endGoalBuffer: 0,
  // Spending flexibility (percentage-based guardrails). The band is hard-coded as ±20%
  // of the reference rate in simulateOnce (see guardrail note there).
  guardrailsEnabled: true, guardrailCutPct: 0.25, guardrailBoostPct: 0.20,
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
  accountsEnabled: true, accounts: { traditional: 280000, roth: 150000, taxable: 270000 },
});

  return { CURRENT_YEAR, HISTORICAL_START_YEAR, HISTORICAL_RETURNS, HISTORICAL_END_YEAR, AVG_HISTORICAL_RETURN, HISTORICAL_SCENARIOS, getHistoricalSequence, withdrawWithTax, simulateOnce, randNormal, pctOf, buildPercentiles, summarize, runMonteCarlo, runHistorical, runFixed, runForState, runNamedScenario, findMaxSpend, FED_BRACKETS_2026, FED_STANDARD_DEDUCTION_2026, CA_BRACKETS_2025, CA_STANDARD_DEDUCTION_2025, CA_MENTAL_HEALTH_THRESHOLD, SS_WAGE_BASE_2026, MEDICARE_RATE, SS_RATE, ADD_MEDICARE_RATE, ADD_MEDICARE_THRESHOLD, STATE_CONFIG, taxFromBrackets, estimateNetIncome, estimateSSBenefit, DEFAULT_STATE, SAMPLE_STATE };
});
