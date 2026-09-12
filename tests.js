'use strict';
/* ============================================================================
   FINANCIAL PLANNER — ENGINE TESTS  (tests.js)
   ----------------------------------------------------------------------------
   Plain Node, no test framework. Run:  node tests.js   (exit 0 = pass)
   Exercises the pure engine in engine.js across the documented edge cases and
   asserts the core invariants. No DOM, no network.
============================================================================ */
const assert = require('node:assert');
const E = require('./engine.js');

// ---- tiny harness -----------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failed++; failures.push({ name, err }); console.error('  ✗ ' + name + '\n    ' + (err && err.message || err)); }
}
const MODES = ['fixed', 'montecarlo', 'historical'];

// Build a full state from DEFAULT_STATE so no field is missing.
function mk(overrides) { return Object.assign(JSON.parse(JSON.stringify(E.DEFAULT_STATE)), overrides); }
const inUnit = (x) => typeof x === 'number' && isFinite(x) && x >= 0 && x <= 1;

// ---- edge-case states -------------------------------------------------------
const CASES = {
  'age 18, $0 portfolio':      mk({ age: 18, portfolio: 0, spending: 30000 }),
  'age 70, already retired':   mk({ age: 70, portfolio: 800000, spending: 50000, yourIncome: 0,
                                    yourStopWorkAge: 65, ssStartAge: 67, yourSSAmount: 25000 }),
  'single person':             mk({ age: 55, hasPartner: false, partnerAge: 0, portfolio: 600000,
                                    spending: 40000, yourIncome: 90000, yourSSAmount: 24000 }),
  'very high income':          mk({ age: 45, portfolio: 5000000, spending: 300000, yourIncome: 2000000,
                                    yourSSAmount: 45000 }),
  'very low income':           mk({ age: 45, portfolio: 20000, spending: 15000, yourIncome: 8000,
                                    yourSSAmount: 9000 }),
  'spending > portfolio':      mk({ age: 60, portfolio: 50000, spending: 200000, yourIncome: 0 }),
};

// ---- 1. success rate stays in [0,1] across every case and mode --------------
for (const [label, base] of Object.entries(CASES)) {
  for (const simMode of MODES) {
    test(`successRate in [0,1] — ${label} / ${simMode}`, () => {
      const r = E.runForState(Object.assign({}, base, { simMode }));
      assert.ok(inUnit(r.successRate), `successRate=${r.successRate} out of [0,1]`);
      assert.ok(Array.isArray(r.percentiles) && r.percentiles.length >= 1, 'percentiles non-empty');
      assert.ok(isFinite(r.medianFinal), 'medianFinal finite');
    });
  }
}

// inverted horizon (targetAge < age) must not crash — regression for the guard
test('inverted horizon (targetAge < age) does not crash', () => {
  for (const simMode of MODES) {
    const r = E.runForState(mk({ age: 80, targetAge: 70, portfolio: 500000, spending: 40000, simMode }));
    assert.ok(inUnit(r.successRate));
    assert.strictEqual(r.percentiles.length, 1, 'clamps to a 1-year projection');
  }
});

// ---- 2. a portfolio that hits zero never recovers (the `broken` flag) -------
test('once depleted, portfolio stays 0 and ranOut stays true', () => {
  // No income, spending far above portfolio, flat returns -> guaranteed depletion.
  const s = mk({ age: 60, portfolio: 50000, spending: 200000, yourIncome: 0, partnerIncome: 0,
                 hasPartner: false, yourSSAmount: 0, guardrailsEnabled: false, returnRate: 0 });
  const years = E.simulateOnce(s, new Array(s.targetAge - s.age + 1).fill(0));
  const firstOut = years.findIndex(y => y.ranOut);
  assert.ok(firstOut >= 0, 'expected this scenario to deplete');
  for (let i = firstOut; i < years.length; i++) {
    assert.strictEqual(years[i].portfolio, 0, `year idx ${i} portfolio should be 0 after depletion`);
    assert.strictEqual(years[i].ranOut, true, `year idx ${i} ranOut should stay true`);
  }
  // and nothing recovers above zero afterwards
  assert.ok(!years.slice(firstOut).some(y => y.portfolio > 0), 'no recovery above 0 after depletion');
});

// ---- 3. findMaxSpend lands near the end-goal buffer, not millions -----------
// Re-run at the returned spend using the SAME late-life ratio findMaxSpend preserves.
function runAtMaxSpend(s, spend) {
  const ratio = s.spending > 0 ? (s.lateSpending / s.spending) : 1;
  return E.runFixed(Object.assign({}, s, { spending: spend, lateSpending: spend * ratio }));
}
test('findMaxSpend lands near the buffer and within sane bounds', () => {
  const s = mk({ age: 52, portfolio: 700000, spending: 80000, lateSpending: 68000, yourIncome: 0,
                 yourSSAmount: 30000, simMode: 'fixed', endGoalBuffer: 0 });
  const { spend, medianFinal } = E.findMaxSpend(s);
  assert.ok(spend > 0 && spend < 600001, `spend ${spend} should be within [5k,600k] bounds, never millions`);
  assert.ok(spend < 1000000, 'spend is not in the millions');
  // findMaxSpend runs with guardrailsEnabled:false internally, so verify AT the max
  // and one notch higher using the same guardrails-off setting for a fair comparison.
  const sNoGuardrails = Object.assign({}, s, { guardrailsEnabled: false });
  const at = runAtMaxSpend(sNoGuardrails, spend);
  assert.strictEqual(at.medianRunOutAge, null, 'max spend should not run out');
  assert.ok(at.medianFinal >= (s.endGoalBuffer || 0), 'ends at/above the buffer');
  // ...but ends well below the starting portfolio (it actually uses the money up).
  assert.ok(medianFinal < s.portfolio, 'ending balance is near the buffer, not a giant surplus');
  // One notch higher should fail to clear the buffer (confirms we're AT the max, not under it).
  const higher = runAtMaxSpend(sNoGuardrails, spend + 5000);
  assert.ok(higher.medianRunOutAge !== null || higher.medianFinal < at.medianFinal,
    'spending more than the max erodes the ending balance or runs out');
});

test('findMaxSpend respects a non-zero end-goal buffer', () => {
  const buffer = 100000;
  const s = mk({ age: 52, portfolio: 700000, spending: 80000, lateSpending: 68000, yourIncome: 0,
                 yourSSAmount: 30000, simMode: 'fixed', endGoalBuffer: buffer });
  const { spend } = E.findMaxSpend(s);
  const at = runAtMaxSpend(Object.assign({}, s, { guardrailsEnabled: false }), spend); // findMaxSpend searches with guardrails off
  assert.strictEqual(at.medianRunOutAge, null, 'should not run out');
  assert.ok(at.medianFinal >= buffer * 0.9, `ending ${at.medianFinal} should respect buffer ${buffer}`);
});

// ---- 4. more spending never increases the success rate ----------------------
// Deterministic modes only (Monte Carlo has sampling noise). Test guardrails on AND off.
for (const guardrailsEnabled of [false, true]) {
  for (const simMode of ['fixed', 'historical']) {
    test(`success rate is monotonic non-increasing in spending — ${simMode} / guardrails ${guardrailsEnabled ? 'on' : 'off'}`, () => {
      const base = mk({ age: 52, portfolio: 700000, yourIncome: 0, yourSSAmount: 30000,
                        partnerSSAmount: 18000, hasPartner: true, partnerAge: 50,
                        simMode, guardrailsEnabled });
      const spends = [30000, 50000, 70000, 90000, 110000, 140000, 180000];
      let prev = Infinity;
      for (const sp of spends) {
        const r = E.runForState(Object.assign({}, base, { spending: sp, lateSpending: Math.round(sp * 0.85) }));
        assert.ok(inUnit(r.successRate));
        assert.ok(r.successRate <= prev + 1e-9,
          `successRate rose from ${prev} to ${r.successRate} when spending increased to ${sp}`);
        prev = r.successRate;
      }
    });
  }
}

// ---- 5. estimateNetIncome vs verified 2026 IRS figures ----------------------
// Federal tax recomputed by hand from the verified 2026 brackets/standard deduction.
function expectedFederal2026(gross, status) {
  const sd = status === 'single' ? 16100 : 32200;
  const brackets = status === 'single'
    ? [[0,0.10],[12400,0.12],[50400,0.22],[105700,0.24],[201775,0.32],[256225,0.35],[640600,0.37]]
    : [[0,0.10],[24800,0.12],[100800,0.22],[211400,0.24],[403550,0.32],[512450,0.35],[768700,0.37]];
  let taxable = Math.max(0, gross - sd), tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lo = brackets[i][0], rate = brackets[i][1];
    const hi = i < brackets.length - 1 ? brackets[i+1][0] : Infinity;
    if (taxable > lo) tax += (Math.min(taxable, hi) - lo) * rate; else break;
  }
  return tax;
}
for (const [gross, status] of [[60000,'single'], [150000,'mfj'], [400000,'mfj']]) {
  test(`estimateNetIncome federal matches 2026 brackets — $${gross} ${status}`, () => {
    const r = E.estimateNetIncome({ gross, filingStatus: status, stateCode: 'TX' }); // TX => no state tax
    assert.strictEqual(r.federal, Math.round(expectedFederal2026(gross, status)),
      `federal mismatch for ${gross}/${status}`);
    assert.strictEqual(r.state, 0, 'Texas has no state income tax');
    assert.ok(inUnit(r.effectiveRate), 'effective rate in [0,1]');
    assert.ok(r.net > 0 && r.net < gross, 'net is between 0 and gross');
  });
}
test('estimateNetIncome handles zero / negative gross', () => {
  for (const g of [0, -5000]) {
    const r = E.estimateNetIncome({ gross: g });
    assert.deepStrictEqual([r.net, r.federal, r.state, r.fica, r.totalTax, r.effectiveRate], [0,0,0,0,0,0]);
  }
});
test('FICA caps Social Security portion at the 2026 wage base', () => {
  // Above the wage base, extra income adds only Medicare (1.45%) + addl Medicare, not 6.2% SS.
  const lo = E.estimateNetIncome({ gross: E.SS_WAGE_BASE_2026, filingStatus: 'single', stateCode: 'TX' });
  const hi = E.estimateNetIncome({ gross: E.SS_WAGE_BASE_2026 + 100000, filingStatus: 'single', stateCode: 'TX' });
  const ficaDelta = hi.fica - lo.fica;
  // 100k more wages over the cap => ~1.45% + 0.9% addl Medicare = ~2.35% => ~2350, definitely < 6.2% (6200).
  assert.ok(ficaDelta < 100000 * 0.062, 'no 6.2% SS tax applied above the wage base');
  assert.ok(ficaDelta > 0, 'Medicare still applies above the cap');
});

// ---- 6. estimateSSBenefit vs the verified 2026 PIA formula ------------------
test('estimateSSBenefit applies the 90/32/15 bend-point formula (2026 bend points)', () => {
  assert.strictEqual(E.estimateSSBenefit(0), 0);
  assert.strictEqual(E.estimateSSBenefit(-100), 0);
  // First bend only: $12,000/yr -> AIME $1,000 (<= 1286) -> 90% -> $900/mo -> $10,800/yr
  assert.strictEqual(E.estimateSSBenefit(12000), Math.round(1000 * 0.9 * 12));
  // Mid: $90,000/yr -> AIME $7,500 -> 0.9*1286 + 0.32*(7500-1286), monthly, *12
  const aime = 7500, expected = Math.round((1286*0.9 + (aime-1286)*0.32) * 12);
  assert.strictEqual(E.estimateSSBenefit(90000), expected);
  // Benefit is monotonic non-decreasing in income and capped at the wage base.
  assert.ok(E.estimateSSBenefit(300000) >= E.estimateSSBenefit(150000));
  assert.strictEqual(E.estimateSSBenefit(E.SS_WAGE_BASE_2026 + 500000), E.estimateSSBenefit(E.SS_WAGE_BASE_2026));
});

// ---- 7. Reference scenarios (Bengen / Trinity ballparks) ----------------------
// A "pure withdrawal" retiree: no wages, no SS, no housing, flat real spending,
// guardrails OFF, tax gross-up OFF, no fees. Horizon = targetAge - age + 1 years.
// Literature (Ibbotson SBBI data, different end years): 4%/30y ~95%+ at 100% stocks and
// 95-100% at 60/40; 3.5%/40y ~95-100%; 5%/25y roughly 80-90%. Bands are deliberately wide:
// they should catch a broken engine or a bad data rebuild, not a data refresh.
function pureWithdrawal(portfolio, spend, years, extra) {
  return mk(Object.assign({
    age: 65, targetAge: 65 + years - 1, hasPartner: false, partnerAge: 0,
    portfolio, spending: spend, lateSpending: spend, slowDownAge: 200,
    yourIncome: 0, partnerIncome: 0, yourStopWorkAge: 65,
    yourSSAmount: 0, partnerSSAmount: 0, housing: 0,
    guardrailsEnabled: false, capGainsTax: 0, taxRate: 0, feeRate: 0, accountsEnabled: false,
    simMode: 'historical',
  }, extra || {}));
}
const REF = [
  // name, portfolio, spend, years, stockPct, expected windows, [min,max] success band, required failing start years (or null)
  ['A: $1M, 4% ($40k), 30y, 100% stocks', 1000000, 40000, 30, 1.0, 71, [0.85, 1.00], ['1929','1966','1968','1969']],
  ['A: $1M, 4% ($40k), 30y, 60/40',       1000000, 40000, 30, 0.6, 71, [0.85, 1.00], null],
  ['B: $1M, 3.5% ($35k), 40y, 100% stocks', 1000000, 35000, 40, 1.0, 61, [0.90, 1.00], []],
  ['B: $1M, 3.5% ($35k), 40y, 60/40',       1000000, 35000, 40, 0.6, 61, [0.90, 1.00], null],
  ['C: $1M, 5% ($50k), 25y, 100% stocks', 1000000, 50000, 25, 1.0, 76, [0.65, 0.92], null],
  ['C: $1M, 5% ($50k), 25y, 60/40',       1000000, 50000, 25, 0.6, 76, [0.65, 0.92], null],
  ['D: $500k, $25k (5%), 30y, 100% stocks', 500000, 25000, 30, 1.0, 71, [0.65, 0.92], null],
  ['D: $500k, $25k (5%), 30y, 60/40',       500000, 25000, 30, 0.6, 71, [0.60, 0.92], null],
];
for (const [name, p, w, y, stockPct, windows, [lo, hi], mustFail] of REF) {
  test(`reference scenario — ${name}`, () => {
    const r = E.runForState(pureWithdrawal(p, w, y, { stockPct }));
    assert.strictEqual(r.percentiles.length, y, `horizon should be exactly ${y} years`);
    assert.strictEqual(r.totalPeriods, windows, `expected ${windows} rolling ${y}-year windows from 1926-${E.HISTORICAL_END_YEAR}`);
    assert.strictEqual(r.windows.count, windows);
    assert.strictEqual(r.windows.lastStart, E.HISTORICAL_END_YEAR - y + 1);
    assert.ok(r.successRate >= lo && r.successRate <= hi,
      `successRate ${(r.successRate*100).toFixed(1)}% outside accepted band [${lo*100}%, ${hi*100}%]`);
    assert.strictEqual(r.failureCount, r.totalPeriods - r.successCount);
    if (mustFail) {
      const failStarts = r.failures.map(f => f.label.split('–')[0]).sort();
      assert.deepStrictEqual(failStarts, mustFail.slice().sort(), 'failing start years should be the classic bad sequences');
    }
  });
}
test('reference scenarios are ordered sensibly and scale-free', () => {
  const rate = (p, w, y, extra) => E.runForState(pureWithdrawal(p, w, y, extra)).successRate;
  const A = rate(1000000, 40000, 30), D = rate(500000, 25000, 30);
  assert.ok(D <= A + 1e-9, '5% withdrawal should not beat 4% over the same horizon');
  assert.strictEqual(rate(500000, 20000, 30), A, '4%/30y success must be identical at $500k and $1M');
  assert.ok(rate(1000000, 40000, 30, { feeRate: 0.01 }) <= A, 'a 1% fee cannot improve success');
  assert.ok(rate(1000000, 40000, 30, { feeRate: 0.01 }) < A, 'a 1% fee should lower success over 30 years');
});
// Defaults change the answer materially; pin that so a future change is noticed.
test('reference scenario A with DEFAULT_STATE knobs left on differs from the pure case', () => {
  const pure = E.runForState(pureWithdrawal(1000000, 40000, 30)).successCount;
  const withTax = E.runForState(pureWithdrawal(1000000, 40000, 30, { capGainsTax: 0.15 })).successCount;
  const withGuard = E.runForState(pureWithdrawal(1000000, 40000, 30, { guardrailsEnabled: true })).successCount;
  assert.ok(withTax < pure, 'the 15% gross-up on every withdrawal should lower success');
  assert.ok(withGuard >= pure, 'guardrails should not lower success');
});

// ---- 8. Data series and blends ----------------------------------------------
test('stock and bond series cover 1926-2025 with plausible real-return statistics', () => {
  assert.strictEqual(E.STOCK_RETURNS.length, 100);
  assert.strictEqual(E.BOND_RETURNS.length, E.STOCK_RETURNS.length);
  assert.strictEqual(E.HISTORICAL_END_YEAR, 2025);
  const s = E.historicalStats(1.0), b = E.historicalStats(0.0), m = E.historicalStats(0.6);
  assert.ok(s.geo > 0.05 && s.geo < 0.09, `stock real geometric mean ${s.geo} should be ~6-8%`);
  assert.ok(s.sd > 0.15 && s.sd < 0.25, `stock sd ${s.sd} should be ~16-22%`);
  assert.ok(b.geo > 0.0 && b.geo < 0.04, `bond real geometric mean ${b.geo} should be ~1-3%`);
  assert.ok(b.sd > 0.05 && b.sd < 0.12, `bond sd ${b.sd} should be ~6-10%`);
  assert.ok(m.sd < s.sd && m.sd > b.sd, 'blend volatility sits between the two assets');
  assert.ok(m.geo < s.geo && m.geo > b.geo, 'blend return sits between the two assets');
  // blend is a weighted average year by year
  const y = 10;
  assert.ok(Math.abs(E.blendSeries(0.6)[y] - (0.6 * E.STOCK_RETURNS[y] + 0.4 * E.BOND_RETURNS[y])) < 1e-12);
  assert.strictEqual(E.getHistoricalSequence(1926, 30, 1.0)[0], E.STOCK_RETURNS[0]);
  assert.strictEqual(E.getHistoricalSequence(1997, 30, 1.0), null, 'no window can start after 1996 for 30 years');
});
test('a bond-heavier mix narrows the outcome range for the same plan', () => {
  const stocks = E.runForState(pureWithdrawal(1000000, 40000, 30, { stockPct: 1.0 }));
  const mixed = E.runForState(pureWithdrawal(1000000, 40000, 30, { stockPct: 0.5 }));
  const last = (r) => r.percentiles[r.percentiles.length - 1];
  assert.ok(last(mixed).p90 - last(mixed).p10 < last(stocks).p90 - last(stocks).p10, 'p10-p90 spread should shrink with more bonds');
});

// ---- 9. Monte Carlo is seeded and follows the data by default -----------------
test('Monte Carlo — same seed gives identical results, different seed differs', () => {
  const s = pureWithdrawal(1000000, 40000, 30, { simMode: 'montecarlo' });
  const a = E.runForState(s), b = E.runForState(s);
  assert.strictEqual(a.successRate, b.successRate, 'seeded runs must be reproducible');
  assert.strictEqual(a.medianFinal, b.medianFinal);
  const c = E.runForState(Object.assign({}, s, { mcSeed: 7 }));
  assert.notStrictEqual(a.medianFinal, c.medianFinal, 'a different seed should give different paths');
  assert.strictEqual(a.mcSims, 500);
  assert.strictEqual(E.runForState(Object.assign({}, s, { mcSims: 50 })).mcSims, 50);
});
test('Monte Carlo — default mean/sd equal the chosen blend\'s historical statistics', () => {
  const s = pureWithdrawal(1000000, 40000, 30, { simMode: 'montecarlo', stockPct: 0.6 });
  const r = E.runForState(s);
  const h = E.historicalStats(0.6);
  assert.ok(Math.abs(r.mcMean - h.mean) < 1e-12 && Math.abs(r.mcSd - h.sd) < 1e-12);
  assert.ok(E.mcParams(s).fromHistory);
  const o = E.runForState(Object.assign({}, s, { mcMean: 0.03, mcSd: 0.10 }));
  assert.strictEqual(o.mcMean, 0.03); assert.strictEqual(o.mcSd, 0.10);
  assert.ok(!E.mcParams(Object.assign({}, s, { mcMean: 0.03 })).fromHistory);
});
test('Monte Carlo — scenario A lands in a plausible band for the historical-matched 60/40 portfolio', () => {
  const r = E.runForState(pureWithdrawal(1000000, 40000, 30, { simMode: 'montecarlo' }));
  assert.ok(r.successRate > 0.75 && r.successRate < 0.99, `MC success ${r.successRate} outside [75%, 99%]`);
});

// ---- 10. Summary semantics ----------------------------------------------------
test('medianRun is the path whose ending balance equals the median ending balance', () => {
  for (const simMode of ['historical', 'montecarlo']) {
    const r = E.runForState(pureWithdrawal(1000000, 40000, 30, { simMode }));
    assert.strictEqual(r.medianRun[r.medianRun.length - 1].portfolio, r.medianFinal);
  }
});
test('medianRunOutAge is null only when nothing failed, and failureCount matches', () => {
  const ok = E.runForState(pureWithdrawal(1000000, 35000, 40, { stockPct: 1.0 }));
  assert.strictEqual(ok.failureCount, 0); assert.strictEqual(ok.medianRunOutAge, null);
  const some = E.runForState(pureWithdrawal(1000000, 50000, 25, { stockPct: 1.0 }));
  assert.ok(some.failureCount > 0 && some.medianRunOutAge !== null);
  assert.ok(some.medianRunOutAge >= 65 && some.medianRunOutAge <= 89);
});

// ---- 11. findMaxSpendAtSuccess ---------------------------------------------------
test('findMaxSpendAtSuccess returns the highest spend meeting the threshold, below the steady-return max', () => {
  const s = pureWithdrawal(1000000, 40000, 30, { stockPct: 1.0 });
  const h = E.findMaxSpendAtSuccess(s, 0.85);
  assert.ok(h.successRate >= 0.85, 'meets the threshold');
  assert.ok(h.spend > 30000 && h.spend < 60000, `historical max ${h.spend} should be in the 3-6% range`);
  const higher = E.runForState(Object.assign({}, s, { spending: h.spend + 2000, lateSpending: h.spend + 2000 }));
  assert.ok(higher.successRate < 0.85, 'spending $2k more should drop below the threshold');
  const steady = E.findMaxSpend(Object.assign({}, s, { simMode: 'fixed' })).spend;
  assert.ok(h.spend < steady, 'the sequence-risk-aware max is below the steady 5% max');
  assert.ok(E.findMaxSpendAtSuccess(s, 1.0).spend <= h.spend, 'a stricter threshold gives a lower or equal spend');
});

// ---- 12. Tax rates: wage vs retirement ------------------------------------------
test('retirementTaxRate falls back to taxRate and is used for traditional withdrawals', () => {
  const base = mk({ taxRate: 0.25 });
  assert.strictEqual(E.retirementTaxRate(base), 0.25);
  assert.strictEqual(E.retirementTaxRate(mk({ taxRate: 0.25, retirementTaxRate: 0.12 })), 0.12);
  const accts = { traditional: 1e6, roth: 0, taxable: 0 };
  const hi = E.withdrawWithTax(50000, accts, 'taxSmart', 70, mk({ taxRate: 0.25 }));
  const lo = E.withdrawWithTax(50000, accts, 'taxSmart', 70, mk({ taxRate: 0.25, retirementTaxRate: 0.12 }));
  assert.ok(Math.abs(hi.gross - 50000 / 0.75) < 1e-6 && Math.abs(lo.gross - 50000 / 0.88) < 1e-6);
  const est = E.estimateNetIncome({ gross: 150000, filingStatus: 'mfj', stateCode: 'TX' });
  assert.ok(est.incomeTaxRate < est.effectiveRate, 'income-tax-only rate excludes FICA');
  assert.ok(Math.abs(est.incomeTaxRate - est.federal / 150000) < 1e-3, 'in a no-tax state it is the federal rate');
});
test('guardrails anchor to the first retired withdrawal year, not a pre-retirement top-up', () => {
  // Working household with a small top-up draw for 10 years, then full retirement.
  const s = mk({ age: 52, targetAge: 90, portfolio: 700000, spending: 80000, lateSpending: 80000, slowDownAge: 200,
                 housing: 24000, mortgagePayoffAge: 62, yourIncome: 120000, yourStopWorkAge: 62, taxRate: 0.18,
                 yourSSAmount: 30000, ssStartAge: 67, hasPartner: false, guardrailsEnabled: true, capGainsTax: 0 });
  const seq = new Array(39).fill(0.05);
  const years = E.simulateOnce(s, seq);
  assert.ok(!years.slice(0, 10).some(y => y.flexed), 'no flexing while wages are still coming in');
  assert.ok(years.flexCutCount < 10, `steady 5% returns should not produce near-constant cuts (got ${years.flexCutCount})`);
});

// ---- 13. Career break and contributions pause ------------------------------------
test('career break zeroes wages for the window and resumes after, with no raises during it', () => {
  const s = mk({ age: 35, targetAge: 70, portfolio: 300000, spending: 60000, lateSpending: 60000, slowDownAge: 200,
                 yourIncome: 100000, yourStopWorkAge: 65, yourIncomeGrowth: 0.02, taxRate: 0.2, capGainsTax: 0,
                 yourBreakStart: 37, yourBreakEnd: 39, hasPartner: false, guardrailsEnabled: false });
  const years = E.simulateOnce(s, new Array(36).fill(0.05));
  const y = (a) => years.find(r => r.age === a);
  assert.ok(y(36).yourIncome > 0 && y(37).yourIncome === 0 && y(38).yourIncome === 0 && y(39).yourIncome > 0, 'no wages at 37 and 38 only');
  assert.ok(y(37).onBreak && y(38).onBreak && !y(39).onBreak);
  // Salary at 39 equals salary at 36 grown one year (36 -> 37 raise applied, none during the break).
  assert.ok(Math.abs(y(39).yourIncome - y(36).yourIncome * 1.02) < 1e-6, `expected ${y(36).yourIncome * 1.02}, got ${y(39).yourIncome}`);
  const noBreak = E.runForState(Object.assign({}, s, { yourBreakStart: null, yourBreakEnd: null, simMode: 'historical' }));
  const withBreak = E.runForState(Object.assign({}, s, { simMode: 'historical' }));
  assert.ok(withBreak.medianFinal < noBreak.medianFinal, 'two years without wages must lower the median ending balance');
  assert.ok(withBreak.successRate <= noBreak.successRate + 1e-9);
});
test('career break is not retirement for the guardrail reference', () => {
  const s = mk({ age: 35, targetAge: 90, portfolio: 400000, spending: 70000, lateSpending: 70000, slowDownAge: 200,
                 yourIncome: 90000, yourStopWorkAge: 60, taxRate: 0.2, capGainsTax: 0, yourBreakStart: 36, yourBreakEnd: 38,
                 hasPartner: false, guardrailsEnabled: true });
  const years = E.simulateOnce(s, new Array(56).fill(0.05));
  assert.ok(!years.filter(y => y.age < 60).some(y => y.flexed), 'nothing flexes before the stop-work age, break included');
});
test('a stated investment amount caps what is invested; the rest of take-home is spent', () => {
  // net = 120k * 0.8 = 96k; spend 50k; surplus 46k; invest 15k -> 31k treated as spent.
  const s = mk({ age: 40, targetAge: 80, portfolio: 200000, spending: 50000, lateSpending: 50000, slowDownAge: 200,
                 yourIncome: 120000, yourStopWorkAge: 65, taxRate: 0.2, capGainsTax: 0, contributions: 15000,
                 hasPartner: false, guardrailsEnabled: false, yourIncomeGrowth: 0 });
  const y = E.simulateOnce(s, new Array(41).fill(0)).find(r => r.age === 40);
  assert.strictEqual(Math.round(y.spending), 81000); assert.strictEqual(Math.round(y.unallocated), 31000);
  assert.strictEqual(Math.round(-y.withdrawal), 15000, 'exactly the stated amount is invested');
  // blank contributions: everything unspent is invested
  const b = E.simulateOnce(Object.assign({}, s, { contributions: 0 }), new Array(41).fill(0)).find(r => r.age === 40);
  assert.strictEqual(Math.round(b.spending), 50000); assert.strictEqual(Math.round(-b.withdrawal), 46000);
  // stated amount above the surplus: the surplus is what goes in, nothing is treated as spent
  const c = E.simulateOnce(Object.assign({}, s, { contributions: 60000 }), new Array(41).fill(0)).find(r => r.age === 40);
  assert.strictEqual(Math.round(c.spending), 50000); assert.strictEqual(Math.round(-c.withdrawal), 46000); assert.strictEqual(c.unallocated, 0);
  // no wages: the rule does not apply
  const r = E.simulateOnce(Object.assign({}, s, { yourIncome: 0 }), new Array(41).fill(0)).find(x => x.age === 40);
  assert.strictEqual(r.unallocated, 0);
});
test('pausing contributions invests nothing for the window and resumes after', () => {
  const s = mk({ age: 40, targetAge: 80, portfolio: 200000, spending: 50000, lateSpending: 50000, slowDownAge: 200,
                 yourIncome: 120000, yourStopWorkAge: 65, taxRate: 0.2, capGainsTax: 0, contributions: 15000,
                 contribPauseStart: 41, contribPauseEnd: 44, hasPartner: false, guardrailsEnabled: false, yourIncomeGrowth: 0 });
  const years = E.simulateOnce(s, new Array(41).fill(0));
  const y = (a) => years.find(r => r.age === a);
  assert.strictEqual(Math.round(-y(40).withdrawal), 15000);
  assert.strictEqual(Math.abs(Math.round(y(41).withdrawal)), 0, 'nothing invested while paused');
  assert.strictEqual(Math.round(y(41).spending), 96000, 'all take-home spent while paused');
  assert.strictEqual(Math.round(-y(44).withdrawal), 15000, 'investing resumes');
  assert.ok(y(41).contribPaused && !y(44).contribPaused);
  const paused = E.runForState(Object.assign({}, s, { simMode: 'historical' }));
  const not = E.runForState(Object.assign({}, s, { contribPauseStart: null, contribPauseEnd: null, simMode: 'historical' }));
  assert.ok(paused.medianFinal < not.medianFinal);
});
test('inWindow treats null bounds as no window and end as exclusive', () => {
  assert.strictEqual(E.inWindow(40, null, null), false);
  assert.strictEqual(E.inWindow(40, 40, 42), true);
  assert.strictEqual(E.inWindow(42, 40, 42), false);
  assert.strictEqual(E.inWindow(39, 40, 42), false);
});

test('part-time years count as working for the guardrail reference', () => {
  const s = mk({ age: 55, targetAge: 90, portfolio: 600000, spending: 60000, lateSpending: 60000, slowDownAge: 200,
                 yourIncome: 100000, yourStopWorkAge: 58, yourPartTimeAmount: 40000, yourPartTimeStart: 58, yourPartTimeEnd: 63,
                 taxRate: 0.2, capGainsTax: 0, hasPartner: false, guardrailsEnabled: true });
  const years = E.simulateOnce(s, new Array(36).fill(0.05));
  const y = (a) => years.find(r => r.age === a);
  assert.strictEqual(Math.round(y(58).yourIncome), 40000, 'part-time wages replace full-time wages');
  assert.strictEqual(y(63).yourIncome, 0, 'wages stop at the part-time end');
  assert.ok(!years.filter(r => r.age < 63).some(r => r.flexed), 'no flexing while part-time wages are coming in');
});
test('part-time for a while, then back to full time', () => {
  const s = mk({ age: 35, targetAge: 70, portfolio: 300000, spending: 60000, lateSpending: 60000, slowDownAge: 200,
                 yourIncome: 100000, yourStopWorkAge: 65, yourPartTimeAmount: 45000, yourPartTimeStart: 37, yourPartTimeEnd: 40,
                 yourIncomeGrowth: 0, taxRate: 0.2, capGainsTax: 0, hasPartner: false, guardrailsEnabled: false });
  const years = E.simulateOnce(s, new Array(36).fill(0.05));
  const y = (a) => years.find(r => r.age === a);
  assert.strictEqual(y(36).yourIncome, 100000); assert.strictEqual(y(37).yourIncome, 45000); assert.strictEqual(y(39).yourIncome, 45000);
  assert.strictEqual(y(40).yourIncome, 100000, 'full-time wages resume'); assert.strictEqual(y(65).yourIncome, 0);
});

test('extra spending applies for its window only and lowers the ending balance', () => {
  const s = mk({ age: 45, targetAge: 90, portfolio: 2500000, spending: 60000, lateSpending: 60000, slowDownAge: 200,
                 yourIncome: 0, hasPartner: false, taxRate: 0, capGainsTax: 0, guardrailsEnabled: false,
                 extraSpend: 25000, extraSpendStart: 50, extraSpendEnd: 54 });
  const years = E.simulateOnce(s, new Array(46).fill(0.03));
  const y = (a) => years.find(r => r.age === a);
  assert.strictEqual(y(49).spending, 60000); assert.strictEqual(y(50).spending, 85000); assert.strictEqual(y(53).spending, 85000); assert.strictEqual(y(54).spending, 60000);
  const base = E.runForState(Object.assign({}, s, { extraSpend: 0, simMode: 'historical' })), more = E.runForState(Object.assign({}, s, { simMode: 'historical' }));
  assert.ok(more.medianFinal < base.medianFinal && more.successRate <= base.successRate);
});

test('freed mortgage payment can be spent after payoff; a home sale adds proceeds and switches housing', () => {
  const base = mk({ age: 50, targetAge: 90, portfolio: 1000000, spending: 30000, lateSpending: 30000, slowDownAge: 200,
                    housing: 24000, mortgagePayoffAge: 60, yourIncome: 0, hasPartner: false, taxRate: 0, capGainsTax: 0, feeRate: 0, guardrailsEnabled: false });
  const flat = new Array(41).fill(0.03);
  const noInfl = new Array(41).fill(0);
  const y = (yrs, a) => yrs.find(r => r.age === a);
  const inv = E.simulateOnce(base, flat, noInfl);
  assert.strictEqual(y(inv, 59).spending, 54000); assert.strictEqual(y(inv, 60).spending, 30000, 'housing drops to zero after payoff');
  const spent = E.simulateOnce(Object.assign({}, base, { postPayoffSpend: 24000 }), flat, noInfl);
  assert.strictEqual(y(spent, 60).spending, 54000, 'freed payment spent instead');
  assert.ok(y(spent, 89).portfolio < y(inv, 89).portfolio);
  const sale = E.simulateOnce(Object.assign({}, base, { homeSaleAge: 70, homeSaleProceeds: 400000, postSaleHousing: 18000 }), flat, noInfl);
  assert.strictEqual(y(sale, 69).spending, 30000); assert.strictEqual(y(sale, 70).spending, 48000, 'rent from the sale year');
  assert.ok(y(sale, 70).portfolio - y(inv, 70).portfolio > 300000, 'proceeds arrive in the sale year');
  assert.ok(Math.abs((y(sale, 70).portfolio) - (y(sale, 70).portfolioStart - y(sale, 70).withdrawal) * 1.03) < 1, 'sale-year balance grows normally');
});

// ---- 15. What would it take ------------------------------------------------------
test('findRetireAgeAtSuccess finds the first stop-work age that clears the threshold', () => {
  const s = mk({ age: 45, targetAge: 90, portfolio: 400000, spending: 60000, lateSpending: 60000, slowDownAge: 200,
                 yourIncome: 100000, yourStopWorkAge: 50, taxRate: 0.2, capGainsTax: 0, feeRate: 0, hasPartner: false,
                 yourSSAmount: 20000, guardrailsEnabled: false, stockPct: 0.6 });
  const now = E.runForState(Object.assign({}, s, { simMode: 'historical' }));
  assert.ok(now.successRate < 0.85, 'test case should start below the threshold');
  const r = E.findRetireAgeAtSuccess(s, 0.85);
  assert.ok(r && r.age > 50 && r.age <= 80, `expected a later age, got ${JSON.stringify(r)}`);
  assert.ok(r.successRate >= 0.85);
  const before = E.runForState(Object.assign({}, s, { simMode: 'historical', yourStopWorkAge: r.age - 1 }));
  assert.ok(before.successRate < 0.85, 'one year earlier should not clear it');
  assert.strictEqual(E.findRetireAgeAtSuccess(Object.assign({}, s, { yourIncome: 0 }), 0.85), null, 'no wages, no answer');
});
test('findPortfolioAtSuccess finds the portfolio that clears the threshold, and reports when already there', () => {
  const s = mk({ age: 65, targetAge: 94, portfolio: 600000, spending: 40000, lateSpending: 40000, slowDownAge: 200,
                 yourIncome: 0, hasPartner: false, taxRate: 0, capGainsTax: 0, feeRate: 0, guardrailsEnabled: false, stockPct: 0.6 });
  const r = E.findPortfolioAtSuccess(s, 0.85);
  assert.ok(r && !r.alreadyThere && r.portfolio > 600000 && r.portfolio < 1500000, JSON.stringify(r));
  assert.ok(E.runForState(Object.assign({}, s, { simMode: 'historical', portfolio: r.portfolio })).successRate >= 0.85);
  assert.ok(E.runForState(Object.assign({}, s, { simMode: 'historical', portfolio: r.portfolio - 20000 })).successRate < 0.85, 'not far above the line');
  const rich = E.findPortfolioAtSuccess(Object.assign({}, s, { portfolio: 2000000 }), 0.85);
  assert.ok(rich.alreadyThere && rich.portfolio === 2000000);
});

// ---- 14. Market shock ------------------------------------------------------------
test('a market shock splices the era sequence in at the shock age and lowers success', () => {
  const s = pureWithdrawal(1000000, 40000, 30, { stockPct: 1.0 });
  const shocked = Object.assign({}, s, { shockEra: 'dotcom', shockAge: 65 });
  const seq = E.applyShock(new Array(30).fill(0.05), shocked);
  const era = E.getHistoricalSequence(2000, 10, 1.0);
  assert.deepStrictEqual(seq.slice(0, 10), era, 'first ten years are the 2000-2009 real returns');
  assert.strictEqual(seq[10], 0.05, 'later years untouched');
  const base = E.runForState(s), hit = E.runForState(shocked);
  assert.ok(hit.successRate < base.successRate, 'a 2000-2009 start should lower the historical count');
  assert.strictEqual(hit.totalPeriods, base.totalPeriods, 'still one run per period');
  const later = E.runForState(Object.assign({}, s, { shockEra: 'dotcom', shockAge: 80 }));
  assert.ok(later.successRate >= hit.successRate, 'the same decade fifteen years in hurts less');
  assert.strictEqual(E.runForState(Object.assign({}, s, { shockEra: 'dotcom', shockAge: 200 })).successRate, base.successRate, 'a shock outside the horizon changes nothing');
  assert.strictEqual(E.runForState(Object.assign({}, s, { shockEra: 'nope', shockAge: 65 })).successRate, base.successRate, 'unknown era is ignored');
});

// ---- 14b. The mortgage payment is nominal ---------------------------------------
test('a fixed mortgage payment shrinks in today\'s dollars with that year\'s inflation', () => {
  const base = mk({ age: 50, targetAge: 90, portfolio: 1000000, spending: 30000, lateSpending: 30000, slowDownAge: 200,
                    housing: 24000, mortgagePayoffAge: 60, yourIncome: 0, hasPartner: false, taxRate: 0, capGainsTax: 0, feeRate: 0, guardrailsEnabled: false });
  const flat = new Array(41).fill(0.03);
  const y = (yrs, a) => yrs.find(r => r.age === a);
  const steady = E.simulateOnce(base, flat, new Array(41).fill(0.03));
  assert.strictEqual(Math.round(y(steady, 50).housing), 24000, 'first year is the full payment');
  assert.ok(Math.abs(y(steady, 55).housing - 24000 / Math.pow(1.03, 5)) < 1, 'five years of 3% inflation');
  assert.strictEqual(y(steady, 60).housing, 0, 'nothing after payoff');
  const none = E.simulateOnce(base, flat, new Array(41).fill(0));
  assert.strictEqual(y(none, 59).housing, 24000, 'zero inflation leaves it unchanged');
  const defaulted = E.simulateOnce(base, flat);
  assert.ok(Math.abs(y(defaulted, 51).housing - 24000 / (1 + E.LONG_RUN_INFLATION)) < 1, 'no series means the long-run average');
  assert.strictEqual(E.INFLATION.length, E.STOCK_RETURNS.length, 'one inflation value per return year');
  const seq = E.getInflationSequence(1979, 3);
  assert.ok(seq[0] > 0.10 && seq[1] > 0.08, '1979 and 1980 were double-digit inflation years');
  assert.ok(y(defaulted, 89).portfolio > y(none, 89).portfolio, 'a shrinking real payment leaves more in the portfolio');
});

// ---- 14c. Mortgage payoff helper ------------------------------------------------
test('mortgageYearsLeft inverts the payment formula and refuses impossible payments', () => {
  // A payment built by the engine's own formula should come back as the same term.
  for (const [bal, rate, yrs] of [[250000, 6.5, 15], [400000, 3.25, 22], [90000, 7.9, 5]]) {
    const monthly = bal * (rate / 100 / 12) * Math.pow(1 + rate / 100 / 12, yrs * 12) / (Math.pow(1 + rate / 100 / 12, yrs * 12) - 1);
    const back = E.mortgageYearsLeft(bal, rate, monthly * 12);
    assert.ok(Math.abs(back - yrs) < 0.02, `${bal} at ${rate}% over ${yrs}y came back as ${back}`);
  }
  assert.strictEqual(E.mortgageYearsLeft(0, 6, 24000), 0, 'nothing left to pay');
  assert.strictEqual(E.mortgageYearsLeft(250000, 6, 0), null, 'no payment');
  assert.strictEqual(E.mortgageYearsLeft(250000, 6, 12000), null, 'payment below the interest never clears it');
  assert.ok(Math.abs(E.mortgageYearsLeft(120000, 0, 12000) - 10) < 1e-9, 'zero interest is plain division');
  const quicker = E.mortgageYearsLeft(250000, 6.5, 30000);
  const slower = E.mortgageYearsLeft(250000, 6.5, 24000);
  assert.ok(quicker < slower, 'paying more finishes sooner');
});

// ---- 15. Paywall decisions (paywall.js) -------------------------------------
const P = require('./paywall.js');
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const NOW = 1757500000000;
const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const goodBlob = { key: KEY, instanceId: 'inst-1', status: 'active', activatedAt: NOW - 3 * DAY, lastCheck: NOW - HOUR, lastResult: 'valid' };

test('paywall: no blob, or a blob without an instance, is not paid', () => {
  assert.deepStrictEqual(P.licenseDecision(null, NOW), { paid: false, needsCheck: false });
  assert.deepStrictEqual(P.licenseDecision(undefined, NOW), { paid: false, needsCheck: false });
  assert.deepStrictEqual(P.licenseDecision({ key: KEY }, NOW), { paid: false, needsCheck: false }, 'missing instanceId');
  assert.deepStrictEqual(P.licenseDecision({ instanceId: 'x' }, NOW), { paid: false, needsCheck: false }, 'missing key');
});
test('paywall: any status other than active is not paid', () => {
  for (const status of ['inactive', 'disabled', 'expired', 'invalid', undefined]) {
    assert.strictEqual(P.licenseDecision(Object.assign({}, goodBlob, { status }), NOW).paid, false, String(status));
  }
});
test('paywall: an explicit invalid result locks Pro', () => {
  assert.strictEqual(P.licenseDecision(Object.assign({}, goodBlob, { lastResult: 'invalid' }), NOW).paid, false);
});
test('paywall: a stale or network-failed check keeps Pro and asks for a re-check', () => {
  const d = P.licenseDecision(Object.assign({}, goodBlob, { lastResult: 'network', lastCheck: NOW - 30 * DAY }), NOW);
  assert.deepStrictEqual(d, { paid: true, needsCheck: true });
  assert.deepStrictEqual(P.licenseDecision(Object.assign({}, goodBlob, { lastCheck: undefined }), NOW), { paid: true, needsCheck: true }, 'never checked');
});
test('paywall: a check within the last day is paid with no re-check', () => {
  assert.deepStrictEqual(P.licenseDecision(goodBlob, NOW), { paid: true, needsCheck: false });
  assert.strictEqual(P.licenseDecision(Object.assign({}, goodBlob, { lastCheck: NOW - DAY + 1 }), NOW).needsCheck, false, 'just under a day');
  assert.strictEqual(P.licenseDecision(Object.assign({}, goodBlob, { lastCheck: NOW - DAY }), NOW).needsCheck, true, 'exactly a day');
});
test('paywall: an old un-checked spendenough_key is activated once, then ignored', () => {
  assert.deepStrictEqual(P.legacyKeyDecision(KEY, null), { needsActivate: true, key: KEY });
  assert.deepStrictEqual(P.legacyKeyDecision(' ' + KEY + ' ', null), { needsActivate: true, key: KEY }, 'trimmed');
  assert.deepStrictEqual(P.legacyKeyDecision(KEY, goodBlob), { needsActivate: false, key: null }, 'blob already present');
  assert.deepStrictEqual(P.legacyKeyDecision('not-a-key', null), { needsActivate: false, key: null });
  assert.deepStrictEqual(P.legacyKeyDecision(null, null), { needsActivate: false, key: null });
});
test('paywall: /activate replies are classified and only the needed fields are kept', () => {
  const ok = { activated: true, error: null, license_key: { status: 'active', activation_limit: 3, activation_usage: 1 }, instance: { id: 'inst-9', name: 'x' }, meta: { customer_email: 'buyer@example.com' } };
  assert.strictEqual(P.activationOutcome(ok), 'activated');
  const blob = P.licenseFromActivation(KEY, ok, NOW);
  assert.deepStrictEqual(blob, { key: KEY, instanceId: 'inst-9', status: 'active', activatedAt: NOW, lastCheck: NOW, lastResult: 'valid' });
  assert.ok(!JSON.stringify(blob).includes('example.com'), 'the buyer email is never stored');
  assert.strictEqual(P.activationOutcome({ activated: false, error: 'This license key has reached the activation limit.' }), 'limit');
  assert.strictEqual(P.activationOutcome({ activated: false, error: 'license_key not found.' }), 'inactive');
  assert.strictEqual(P.activationOutcome({ activated: true }), 'inactive', 'activated without an instance id is not usable');
  assert.strictEqual(P.activationOutcome(null), 'inactive');
  assert.strictEqual(P.licenseFromActivation(KEY, { activated: false, error: 'x' }, NOW), null);
});
test('paywall: /validate replies update the blob; a network failure keeps lastCheck', () => {
  const valid = P.applyValidation(Object.assign({}, goodBlob, { lastCheck: NOW - 2 * DAY }), { valid: true, license_key: { status: 'active' } }, NOW);
  assert.strictEqual(valid.lastCheck, NOW); assert.strictEqual(valid.lastResult, 'valid'); assert.strictEqual(valid.status, 'active');
  const bad = P.applyValidation(goodBlob, { valid: false, error: 'license_key not found.', license_key: { status: 'disabled' } }, NOW);
  assert.strictEqual(bad.lastResult, 'invalid'); assert.strictEqual(bad.status, 'disabled');
  assert.strictEqual(P.licenseDecision(bad, NOW).paid, false, 'a refunded or disabled key locks Pro');
  const badNoStatus = P.applyValidation(goodBlob, { valid: false, error: 'x' }, NOW);
  assert.strictEqual(badNoStatus.status, 'invalid');
  const net = P.applyValidation(Object.assign({}, goodBlob, { lastCheck: NOW - 2 * DAY }), null, NOW);
  assert.strictEqual(net.lastResult, 'network'); assert.strictEqual(net.lastCheck, NOW - 2 * DAY, 'retry next load');
  assert.deepStrictEqual(P.licenseDecision(net, NOW), { paid: true, needsCheck: true }, 'grace: still Pro');
  assert.strictEqual(goodBlob.lastResult, 'valid', 'input blob is not mutated');
});
test('paywall: the instance label names the browser and platform for the order page', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  assert.strictEqual(P.instanceLabel(mac, 'MacIntel', 'a1b2c3'), 'Spend Enough web · Chrome on Mac · a1b2c3');
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  assert.strictEqual(P.instanceLabel(ios, 'iPhone', '000000'), 'Spend Enough web · Safari on iOS · 000000');
  assert.strictEqual(P.instanceLabel('', '', 'ff'), 'Spend Enough web · browser · ff');
});
test('paywall: the unlocked toast reports the slot count from the activate reply', () => {
  assert.strictEqual(P.proOnMessage({ activated: true, instance: { id: 'i' }, license_key: { activation_limit: 3, activation_usage: 1 } }), 'The full version is on. This browser is 1 of 3 for your key.');
  assert.deepStrictEqual(P.activationSlots({ license_key: { activation_limit: 5, activation_usage: 4 } }), { used: 4, limit: 5 });
  assert.deepStrictEqual(P.activationSlots({}), { used: 1, limit: P.ACTIVATION_LIMIT }, 'missing fields fall back sensibly');
  assert.deepStrictEqual(P.activationSlots({ license_key: { activation_limit: 3, activation_usage: 7 } }), { used: 3, limit: 3 }, 'never above the limit');
});
test('paywall: KEY_RE accepts UUID-shaped keys only', () => {
  assert.ok(P.KEY_RE.test(KEY)); assert.ok(P.KEY_RE.test(KEY.toUpperCase()));
  assert.ok(!P.KEY_RE.test('abc')); assert.ok(!P.KEY_RE.test(KEY + 'x')); assert.ok(!P.KEY_RE.test(''));
});

// ---- summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(`\nFAILED: ${failures.length} test(s) above.`); process.exit(1); }
console.log('All engine and paywall tests passed.');
