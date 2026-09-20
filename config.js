/* ============================================================================
   Spend Enough — deployment configuration (config.js)
   ----------------------------------------------------------------------------
   This is a static site with no build step, so there are no runtime environment
   variables. Public deployment values live here instead. NOTHING in this file is
   secret: checkout URLs and analytics site IDs are visible to every visitor by
   design. API keys, webhook secrets, and the like must never be added here.

   Loaded by index.html (landing), app.html (the app), privacy.html, terms.html.
   Edit the values below, commit, deploy. Empty strings mean "not configured";
   the pages degrade gracefully (checkout button disabled, email form hidden).
============================================================================ */
window.SPENDENOUGH_CONFIG = {
  // Phase 6 — hosted checkout URL from Lemon Squeezy (merchant of record, handles
  // sales tax/VAT). Opens in a new tab. The product must have license keys enabled
  // with an activation limit of 3 (paywall.js ACTIVATION_LIMIT). The buyer never
  // types a key: set the product's post-purchase redirect, the confirmation-screen
  // button, and the receipt-email button ("Open Spend Enough") all to
  // https://<your-domain>/app.html?key=[license_key]. The app activates the key on
  // arrival and strips it from the URL. The receipt-email button is also how a buyer
  // unlocks a second device or a cleared browser; the paste field in the unlock
  // modal is the fallback. https://<your-domain>/app.html?purchased=1 is accepted too
  // (asks for the key from the receipt). Keys are activated and re-checked against
  // https://api.lemonsqueezy.com/v1/licenses (not configurable).
  checkoutUrl: 'https://spendenough.lemonsqueezy.com/checkout/buy/a1941e52-dcd4-4f6b-ac58-0118cef15018',

  // Display price on the unlock screen. Founder lifetime: $39 one-time.
  price: '$39',

  // Phase 5 — landing-page email capture. POST endpoint of your form/email
  // provider (Buttondown, ConvertKit, Formspree, ...). The form sends `email`
  // as application/x-www-form-urlencoded. Empty = the sign-up section is hidden.
  emailEndpoint: '',

  // Phase 5 — optional privacy-respecting analytics (Plausible, Fathom, ...).
  // Set the script URL and site/domain; pages add the <script> tag only when set.
  analyticsScript: '',
  analyticsSite: '',

  // Public site URL, used for canonical and Open Graph tags on the landing page.
  siteUrl: 'https://spendenough.com',
};
