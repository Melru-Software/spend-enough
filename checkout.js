// Opens the Lemon Squeezy checkout as an overlay on the page, the same way their lemon.js
// does, without loading a third-party script: an iframe of the store with ?embed=1, plus the
// two messages the checkout posts back ("mounted" once it has rendered, "close" when the
// customer dismisses it). Any <a class="checkout-button"> whose href is the checkout URL gets
// this behavior; without JavaScript the link still opens the hosted checkout.
(function () {
  var frame = null, loader = null, origin = '';

  function open(url) {
    var u = new URL(url, location.href);
    u.searchParams.set('embed', '1');
    origin = u.origin;
    loader = document.createElement('div');
    loader.className = 'checkout-loader';
    loader.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(250,247,242,0.92)');
    loader.innerHTML = '<style>@keyframes checkout-pulse{0%{opacity:1;transform:scale(.2)}100%{opacity:0;transform:scale(1)}}</style>' +
      '<div style="width:40px;height:40px;border-radius:50%;background:#b5472e;animation:checkout-pulse 1s ease-out infinite"></div>';
    frame = document.createElement('iframe');
    frame.setAttribute('style', 'position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;background:transparent;z-index:2147483647');
    frame.allow = 'payment';
    frame.title = 'Checkout';
    frame.src = u.toString();
    document.body.appendChild(loader);
    document.body.appendChild(frame);
    document.body.classList.add('checkout-open');
    document.documentElement.style.overflow = 'hidden';
  }

  function close() {
    if (frame) frame.remove();
    if (loader) loader.remove();
    frame = loader = null;
    document.body.classList.remove('checkout-open');
    document.documentElement.style.overflow = '';
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a.checkout-button') : null;
    if (!a || !a.href || frame) return;
    // Let cmd/ctrl/shift/middle clicks open the hosted checkout in a new tab as usual.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    open(a.href);
  });

  window.addEventListener('message', function (e) {
    if (!frame || e.origin !== origin) return;
    if (e.data === 'mounted') { if (loader) loader.remove(); loader = null; }
    else if (e.data === 'close') close();
    else if (e.data && e.data.event === 'Checkout.Success' && window.track) track('checkout_success');
  });
})();
