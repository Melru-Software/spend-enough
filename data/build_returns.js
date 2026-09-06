'use strict';
/* ============================================================================
   build_returns.js — rebuilds the annual REAL return series in engine.js
   ----------------------------------------------------------------------------
   Source: Robert Shiller's U.S. stock market dataset (Yale), monthly since 1871:
     http://www.econ.yale.edu/~shiller/data.htm  (ie_data.xls)
   Snapshot used: data/shiller_stock_market_data.csv (CSV export of ie_data.xls
   via github.com/posix4e/shiller_wrapper_data, rows through 2025-12).
   Columns: date_string, sp500, dividend(nominal), dividend(real), earnings,
            earnings(real), cpi, cape, real_price, long_interest_rate (GS10, %).

   Method (January-to-January, the convention cFIREsim also uses):
     inflation_t   = CPI(Jan t+1) / CPI(Jan t) - 1
     STOCK real TR = (realPrice(Jan t+1) + sum over months of realDividend/12) / realPrice(Jan t) - 1
                     (Shiller's dividend column is the trailing-12-month rate, so /12 per month)
     BOND nominal  = 10-year par bond bought at yield y0 = GS10(Jan t), held one year, sold at
                     y1 = GS10(Jan t+1) with 9 years left:  P = y0*(1-(1+y1)^-9)/y1 + (1+y1)^-9,
                     return = P - 1 + y0.  (Constant-maturity approximation; no default risk.)
     BOND real     = (1 + nominal) / (1 + inflation_t) - 1
   The last year (2025) runs January to December because January 2026 is not in the
   snapshot; it is marked partial in the engine comment.

   Run:  node data/build_returns.js   -> prints the two arrays to paste into engine.js
============================================================================ */
const fs = require('fs');
const path = require('path');
const csv = fs.readFileSync(path.join(__dirname, 'shiller_stock_market_data.csv'), 'utf8').trim().split('\n').slice(1);
const rows = {};
for (const l of csv) {
  const c = l.split(',');
  const [y, m] = c[0].split('-').map(Number);
  rows[y + '-' + m] = { divR: +c[3], cpi: +c[6], realP: +c[8], lir: +c[9] };
}
const get = (y, m) => rows[y + '-' + m];
function bondTotalReturn(y0, y1) {
  const n = 9;
  const P = y1 === 0 ? 1 + y0 * n : y0 * (1 - Math.pow(1 + y1, -n)) / y1 + Math.pow(1 + y1, -n);
  return P - 1 + y0;
}
const START = 1926, END = 2025;
const stocks = [], bonds = [], partialYears = [];
for (let y = START; y <= END; y++) {
  const a = get(y, 1);
  let b = get(y + 1, 1);
  if (!b) { b = get(y, 12); partialYears.push(y); }
  const infl = b.cpi / a.cpi - 1;
  let divSum = 0, cnt = 0;
  for (let m = 1; m <= 12; m++) { const r = get(y, m); if (r && r.divR) { divSum += r.divR / 12; cnt++; } }
  if (cnt && cnt < 12) divSum = divSum * 12 / cnt;
  stocks.push(+((b.realP + divSum) / a.realP - 1).toFixed(4));
  bonds.push(+(((1 + bondTotalReturn(a.lir / 100, b.lir / 100)) / (1 + infl)) - 1).toFixed(4));
}
function fmt(arr) { const out = []; for (let i = 0; i < arr.length; i += 10) out.push('  ' + arr.slice(i, i + 10).join(',')); return out.join(',\n'); }
console.log('// STOCK_RETURNS (' + START + '-' + END + ', ' + stocks.length + ' years; partial: ' + partialYears.join(',') + ')');
console.log(fmt(stocks));
console.log('// BOND_RETURNS');
console.log(fmt(bonds));
module.exports = { stocks, bonds, START, END, partialYears };
