// Vitality Chews storefront: cart (stored in this browser), add-to-cart, checkout hand-off to Stripe.
(function () {
  'use strict';
  var KEY = 'vc_cart_v1';
  var P = window.VC_PRODUCTS || {};
  var SHIP = window.VC_SHIPPING || { free: 75, flat: 5.99 };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save(cart) {
    try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) { /* storage unavailable */ }
    updateCount(cart);
  }
  function count(cart) {
    return Object.keys(cart).reduce(function (n, k) { return n + cart[k]; }, 0);
  }
  function money(n) { return '$' + n.toFixed(2); }
  function updateCount(cart) {
    var n = count(cart || load());
    document.querySelectorAll('[data-cart-count]').forEach(function (el) {
      el.textContent = n;
    });
  }
  function toast(msg) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.innerHTML = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4000);
  }

  // Mobile nav
  var toggle = document.querySelector('.nav-toggle');
  if (toggle) toggle.addEventListener('click', function () {
    var nav = document.getElementById('site-nav');
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
  });

  // Product gallery thumbnails
  document.querySelectorAll('[data-thumb]').forEach(function (b) {
    b.addEventListener('click', function () {
      var main = document.querySelector('.gallery-main');
      var stage = document.querySelector('.stage');
      if (main) { main.removeAttribute('srcset'); main.src = b.getAttribute('data-thumb'); }
      if (stage) stage.className = 'stage ' + (b.getAttribute('data-thumb-class') || '');
      document.querySelectorAll('[data-thumb]').forEach(function (x) { x.removeAttribute('aria-current'); });
      b.setAttribute('aria-current', 'true');
    });
  });

  // Quantity stepper on product pages
  document.querySelectorAll('[data-step]').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = b.parentNode.querySelector('[data-qty]');
      var v = (parseInt(input.value, 10) || 1) + parseInt(b.getAttribute('data-step'), 10);
      input.value = Math.max(1, Math.min(12, v));
    });
  });

  // Add to cart
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-add-to-cart]');
    if (!btn) return;
    var slug = btn.getAttribute('data-add-to-cart');
    if (!P[slug]) return;
    var qty = 1;
    if (btn.hasAttribute('data-with-qty')) {
      var input = document.querySelector('[data-qty]');
      qty = Math.max(1, Math.min(12, parseInt(input && input.value, 10) || 1));
    }
    var cart = load();
    cart[slug] = Math.min(12, (cart[slug] || 0) + qty);
    save(cart);
    toast('<img src="' + P[slug].image + '" alt="" style="background:' + P[slug].tint + '"><span><strong>' + P[slug].name + '</strong> added to your cart.</span><a href="/cart/">View cart</a>');
    var label = btn.innerHTML;
    btn.classList.add('added');
    btn.innerHTML = 'Added &#10003;';
    setTimeout(function () { btn.classList.remove('added'); btn.innerHTML = label; }, 1600);
    document.querySelectorAll('.cart-pill').forEach(function (c) { c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); });
    if (document.getElementById('cart-items')) renderCart();
  });

  // Cart page
  var itemsEl = document.getElementById('cart-items');
  function renderCart() {
    var cart = load();
    var slugs = Object.keys(cart).filter(function (s) { return P[s] && cart[s] > 0; });
    var subtotal = 0;
    if (!slugs.length) {
      itemsEl.innerHTML = '<div class="cart-empty"><img src="/img/lineup-900.webp" alt="" width="900" height="417"><h2>Your cart is empty</h2><p class="muted">Pick a gummy for calm, sleep, immune support, joints or daily nutrition.</p><p><a class="btn btn-lg" href="/shop/">Shop gummies</a></p></div>';
    } else {
      itemsEl.innerHTML = slugs.map(function (s) {
        var p = P[s], q = cart[s];
        subtotal += p.price * q;
        return '<div class="cart-row" data-slug="' + s + '">' +
          '<a class="thumb" href="/supplements/' + s + '/" style="background:' + p.tint + '"><img src="' + p.image + '" alt="" width="96" height="96"></a>' +
          '<div><h3><a href="/supplements/' + s + '/">' + p.name + '</a></h3><div class="small muted">' + p.subtitle + ' &middot; ' + money(p.price) + ' each</div>' +
          '<div class="controls"><div class="stepper"><button type="button" data-dec aria-label="Decrease quantity">&minus;</button><span aria-live="polite">' + q + '</span><button type="button" data-inc aria-label="Increase quantity">+</button></div>' +
          '<button type="button" class="remove" data-remove>Remove</button></div></div>' +
          '<span class="line-total">' + money(p.price * q) + '</span></div>';
      }).join('');
    }
    document.querySelector('[data-subtotal]').textContent = money(subtotal);
    var shipEl = document.querySelector('[data-shipping]');
    var note = document.querySelector('[data-free-note]');
    var meter = document.querySelector('[data-ship-meter]');
    var fill = document.querySelector('[data-meter-fill]');
    meter.hidden = !slugs.length;
    fill.style.width = Math.min(100, (subtotal / SHIP.free) * 100) + '%';
    if (!slugs.length) { shipEl.textContent = '—'; note.textContent = ''; }
    else if (subtotal >= SHIP.free) { shipEl.textContent = 'FREE'; note.textContent = 'Nice! Your order ships free.'; }
    else { shipEl.textContent = money(SHIP.flat); note.textContent = 'You are ' + money(SHIP.free - subtotal) + ' away from free shipping.'; }
    document.querySelector('[data-checkout]').disabled = !slugs.length;
    // Suggest products that are not in the cart yet
    var upsell = document.querySelector('[data-cart-upsell]');
    if (upsell) {
      var shown = 0;
      upsell.querySelectorAll('[data-upsell]').forEach(function (el) {
        var inCart = !!cart[el.getAttribute('data-upsell')];
        el.hidden = inCart;
        if (!inCart) shown++;
      });
      upsell.hidden = shown === 0;
    }
  }
  if (itemsEl) {
    renderCart();
    itemsEl.addEventListener('click', function (e) {
      var row = e.target.closest('.cart-row');
      if (!row) return;
      var s = row.getAttribute('data-slug');
      var cart = load();
      if (e.target.closest('[data-inc]')) cart[s] = Math.min(12, cart[s] + 1);
      else if (e.target.closest('[data-dec]')) cart[s] = cart[s] - 1;
      else if (e.target.closest('[data-remove]')) cart[s] = 0;
      else return;
      if (cart[s] <= 0) delete cart[s];
      save(cart);
      renderCart();
    });
    document.querySelector('[data-checkout]').addEventListener('click', function () {
      var btn = this, err = document.querySelector('[data-checkout-error]');
      var cart = load();
      var items = Object.keys(cart).filter(function (s) { return P[s]; }).map(function (s) { return { slug: s, qty: cart[s] }; });
      btn.disabled = true;
      btn.textContent = 'Opening secure checkout…';
      err.textContent = '';
      fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: items }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Checkout failed'); return j; }); })
        .then(function (j) { window.location.href = j.url; })
        .catch(function (e) {
          err.textContent = e.message + ' Please try again or email hello@vitalitychews.com.';
          btn.disabled = false;
          btn.textContent = 'Secure checkout';
        });
    });
  }

  // Order success page
  if (document.body.classList.contains('page-success')) {
    var sid = new URLSearchParams(location.search).get('session_id');
    var msg = document.querySelector('[data-order-msg]');
    if (sid) {
      fetch('/api/order?session_id=' + encodeURIComponent(sid))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (o) {
          if (o && o.orderNumber) {
            msg.textContent = 'Your order number is ' + o.orderNumber + '.';
            save({});
          } else {
            msg.textContent = 'Your payment was received.';
          }
        })
        .catch(function () { msg.textContent = 'Your payment was received.'; });
    }
  }

  updateCount();
})();
