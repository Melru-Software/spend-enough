/* ============================================================================
   Spend Enough — cookie-free analytics (analytics.js)
   ----------------------------------------------------------------------------
   Loaded on every page right after config.js. Uses Umami Cloud
   (https://umami.is), which sets no cookies and keeps no IP addresses in its
   analytics records. Nothing loads until config.js has both analyticsScript and
   analyticsWebsiteId, so with either one empty the site sends nothing anywhere.

   What gets recorded (keep privacy.html in step with this list):
     - a page view per page, with the address minus anything after ? or #
       (data-exclude-search / data-exclude-hash), so a license key passed as
       app.html?key=... or a shared scenario never reaches the analytics;
     - the named events passed to track() below.
   Browsers that send Do Not Track are not counted (data-do-not-track), and only
   the live domain from config.js siteUrl is counted (data-domains), so local
   copies and Netlify deploy previews stay out of the numbers.

   Events in use:
     ran_model         app.html   finished the setup form and ran the planner on your own numbers
     hit_paywall       app.html   the paid-version screen was shown
     clicked_checkout  any page   a click on any .checkout-button (the buy button)
     checkout_success  checkout.js  the checkout overlay reported a finished order
     purchased         app.html   the paid version was unlocked in this browser
     downloaded_csv    app.html   CSV export
     printed_report    app.html   print / PDF report
   clicked_checkout is wired here, not on the button: any buy link carrying the
   class "checkout-button" is counted, whatever payment provider it points to.
============================================================================ */
(function () {
  var c = window.SPENDENOUGH_CONFIG || {};

  // Named events. Safe to call before the Umami script has loaded, or with
  // analytics switched off: it simply does nothing.
  window.track = function (name) {
    try { if (window.umami && typeof window.umami.track === 'function') window.umami.track(name); }
    catch (e) { /* analytics must never break the page */ }
  };

  if (!c.analyticsScript || !c.analyticsWebsiteId) return;

  var s = document.createElement('script');
  s.defer = true;
  s.src = c.analyticsScript;
  s.setAttribute('data-website-id', c.analyticsWebsiteId);
  s.setAttribute('data-exclude-search', 'true');
  s.setAttribute('data-exclude-hash', 'true');
  s.setAttribute('data-do-not-track', 'true');
  try {
    if (c.siteUrl) {
      var host = new URL(c.siteUrl).hostname.replace(/^www\./, '');
      s.setAttribute('data-domains', host + ',www.' + host);
    }
  } catch (e) { /* bad siteUrl: count every host */ }
  document.head.appendChild(s);

  // Buy-button clicks, counted for any element with class "checkout-button".
  // Capture phase, so it runs before checkout.js opens the overlay.
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.checkout-button') : null;
    if (b) window.track('clicked_checkout');
  }, true);
})();
