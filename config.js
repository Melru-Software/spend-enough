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
  // Phase 6 — hosted checkout URL from Lemon Squeezy (recommended; merchant of
  // record, handles sales tax/VAT) or a Stripe Payment Link. Opens in a new tab.
  // If the provider can put the license key in the redirect URL, point the
  // post-purchase redirect at https://<your-domain>/app.html?key=<KEY> and the app
  // unlocks itself; otherwise buyers paste the key from their receipt email.
  checkoutUrl: '',

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
  siteUrl: '',
};
