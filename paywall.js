/* ============================================================================
   SPEND ENOUGH — PAYWALL DECISIONS  (paywall.js)
   ----------------------------------------------------------------------------
   Pure, DOM-free license logic. Loaded by app.html via <script src="paywall.js">
   (attaches its exports to window) and by tests.js via require() in Node.
   No network and no storage here: app.html does the fetch and localStorage work
   and hands the JSON in. NO build step — plain ES2017.

   The license lives in localStorage as one JSON blob (spendenough_license):
     { key, instanceId, status, activatedAt, lastCheck, lastResult }
   status     = last known Lemon Squeezy license_key.status ("active", "disabled", ...)
   lastCheck  = ms epoch of the last successful /validate (or the activation)
   lastResult = "valid" | "invalid" | "network"

   Design (docs/launch/phase6-license-activation.md): a stale or network-failed
   check never locks a paying customer out; only an explicit "not valid" answer
   from the provider does.
============================================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node (tests.js)
  else Object.assign(root, api);                                            // browser: globals on window
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Lemon Squeezy license keys are UUIDs. Anything else is not a key.
  const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Re-confirm a key with the provider about once a day.
  const LICENSE_RECHECK_MS = 24 * 60 * 60 * 1000;
  // Must match the activation limit set on the product in the Lemon Squeezy dashboard.
  const ACTIVATION_LIMIT = 3;

  const LICENSE_MSG = {
    shape: 'That is not a license key (they look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).',
    limit: 'This key is already in use on ' + ACTIVATION_LIMIT + ' browsers. Free one up from your order page (link in your receipt email) and try again.',
    inactive: 'That key isn’t active. Check the receipt email, or reply to it and we’ll sort it out.',
    network: 'Couldn’t reach the license server. Check your connection and try again.',
    purchased: 'Thanks for buying. Your license key is in the receipt email; paste it below to unlock Pro.',
    slots: 'A key works in up to ' + ACTIVATION_LIMIT + ' browsers.',
    unlocking: 'Unlocking Pro…'
  };

  // How many of the key's slots are in use after a successful /activate, for the toast.
  function activationSlots(res) {
    const lk = (res && res.license_key) || {};
    const limit = +lk.activation_limit || ACTIVATION_LIMIT;
    const used = Math.min(limit, Math.max(1, +lk.activation_usage || 1));
    return { used, limit };
  }
  function proOnMessage(res) {
    const s = activationSlots(res);
    return 'Pro is on. This browser is ' + s.used + ' of ' + s.limit + ' for your key.';
  }

  // The one synchronous question the UI asks: is Pro unlocked, and is the stored
  // answer old enough that the app should re-check with the provider in the background?
  function licenseDecision(blob, now) {
    if (!blob || typeof blob !== 'object' || !blob.key || !blob.instanceId) return { paid: false, needsCheck: false };
    if (blob.status !== 'active') return { paid: false, needsCheck: false };
    if (blob.lastResult === 'invalid') return { paid: false, needsCheck: false };
    const last = +blob.lastCheck || 0;
    return { paid: true, needsCheck: (now - last) >= LICENSE_RECHECK_MS };
  }

  // Before Phase 6 the app stored a bare, never-checked key in spendenough_key.
  // Such a key gets one activation attempt on load; the blob replaces it.
  function legacyKeyDecision(legacyKey, blob) {
    if (blob && blob.key) return { needsActivate: false, key: null };
    const k = (legacyKey || '').trim();
    return KEY_RE.test(k) ? { needsActivate: true, key: k } : { needsActivate: false, key: null };
  }

  // Classify a /activate response body: 'activated' | 'limit' | 'inactive'.
  function activationOutcome(res) {
    if (res && res.activated === true && res.instance && res.instance.id) return 'activated';
    const err = String((res && res.error) || '').toLowerCase();
    return err.indexOf('activation limit') !== -1 ? 'limit' : 'inactive';
  }

  // The blob to store after a successful /activate, or null if it did not activate.
  // Reads only status and instance.id; the response also carries the buyer's email,
  // which is deliberately never stored.
  function licenseFromActivation(key, res, now) {
    if (activationOutcome(res) !== 'activated') return null;
    return {
      key: key,
      instanceId: String(res.instance.id),
      status: (res.license_key && res.license_key.status) || 'active',
      activatedAt: now,
      lastCheck: now,
      lastResult: 'valid'
    };
  }

  // Fold a /validate response into the blob. `res === null` means the request failed
  // (offline, timeout, non-JSON): remember that and leave lastCheck alone so the next
  // load retries. An explicit valid:false locks Pro until the key is activated again.
  function applyValidation(blob, res, now) {
    const next = Object.assign({}, blob);
    if (!res) { next.lastResult = 'network'; return next; }
    next.lastCheck = now;
    if (res.valid === true) {
      next.lastResult = 'valid';
      next.status = (res.license_key && res.license_key.status) || 'active';
    } else {
      next.lastResult = 'invalid';
      next.status = (res.license_key && res.license_key.status) || 'invalid';
    }
    return next;
  }

  // The instance name shown on the buyer's Lemon Squeezy order page, so they can tell
  // which browser to free up. `hex` is a short random suffix supplied by the caller.
  function instanceLabel(userAgent, platform, hex) {
    const ua = String(userAgent || '');
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac'
      : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : String(platform || '');
    return 'Spend Enough web · ' + (os ? browser + ' on ' + os : browser) + ' · ' + String(hex || '');
  }

  return { KEY_RE, LICENSE_RECHECK_MS, ACTIVATION_LIMIT, LICENSE_MSG, licenseDecision, legacyKeyDecision, activationOutcome, licenseFromActivation, applyValidation, instanceLabel, activationSlots, proOnMessage };
});
