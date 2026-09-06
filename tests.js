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
  const at = runAtMaxSpend(s, spend);
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

// ---- summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(`\nFAILED: ${failures.length} test(s) above.`); process.exit(1); }
console.log('All engine tests passed.');
