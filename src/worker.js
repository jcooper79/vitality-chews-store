// Vitality Chews storefront Worker
// - Serves the static site from dist/ (ASSETS binding)
// - /api/checkout          creates a Stripe Checkout Session (prices come from the server-side catalog)
// - /api/stripe-webhook    records paid orders in D1, handles refunds, emails the owner
// - /api/order             order lookup for the thank-you page
// - /api/shipstation       ShipStation "Custom Store" endpoint (order export + ship notify) for Rocktomic fulfillment
// - /api/contact           contact form -> admin inbox
// - /admin                 admin portal (inbox, replies, orders); see src/admin.js
// - email()                inbound mail from Cloudflare Email Routing; see src/mail.js
// - 301 redirects for old WordPress/WooCommerce URLs
import { CATALOG, SHIPPING } from './generated/catalog.js';
import { notifyOwner, handleEmail, handleContact } from './mail.js';
import { handleAdmin } from './admin.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

// ---------- legacy WordPress redirects ----------
const REDIRECTS = {
  '/checkout/': '/cart/',
  '/my-account/': '/contact/',
  '/supplements/': '/shop/',
  '/product/': '/shop/',
  '/home/': '/',
  '/feed/': '/learn/',
};
const GONE = [/^\/wp-(admin|login|content|includes|json)/, /^\/xmlrpc\.php/, /^\/\?(add-to-cart|s)=/];

function legacyRedirect(url) {
  const p = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  if (REDIRECTS[p]) return Response.redirect(url.origin + REDIRECTS[p], 301);
  if (/^\/product-category\//.test(p) || /^\/product-tag\//.test(p)) return Response.redirect(url.origin + '/shop/', 301);
  const prod = p.match(/^\/product\/([^/]+)\/$/); // old WooCommerce default permalink
  if (prod && CATALOG[prod[1]]) return Response.redirect(`${url.origin}/supplements/${prod[1]}/`, 301);
  if (url.searchParams.has('add-to-cart') || url.searchParams.has('remove_item')) return Response.redirect(url.origin + '/cart/', 301);
  if (GONE.some((r) => r.test(url.pathname))) return new Response('Gone', { status: 410 });
  return null;
}

// ---------- Stripe helpers (REST, no SDK) ----------
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function stripe(env, method, path, body) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body ? formEncode(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe error ${res.status}`);
  return data;
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function verifyStripeSignature(env, payload, header) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = parts.t;
  const v1s = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${payload}`);
  return v1s.some((v) => safeEqual(v, expected));
}

// ---------- checkout ----------
async function createCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const items = (body.items || [])
    .filter((i) => CATALOG[i.slug])
    .map((i) => ({ slug: i.slug, qty: Math.max(1, Math.min(12, parseInt(i.qty, 10) || 1)) }));
  if (!items.length) return json({ error: 'Your cart is empty.' }, 400);

  const origin = env.SITE_URL || new URL(request.url).origin;
  const subtotal = items.reduce((s, i) => s + CATALOG[i.slug].price * i.qty, 0);
  const shippingCents = subtotal >= SHIPPING.freeThresholdCents ? 0 : SHIPPING.flatCents;

  const params = {
    mode: 'payment',
    success_url: `${origin}/order/success/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/cart/`,
    billing_address_collection: 'auto',
    shipping_address_collection: { allowed_countries: { 0: 'US' } },
    phone_number_collection: { enabled: 'true' },
    allow_promotion_codes: 'true',
    shipping_options: {
      0: {
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: shippingCents === 0 ? 'Free USPS shipping' : 'USPS shipping',
          fixed_amount: { amount: shippingCents, currency: 'usd' },
          delivery_estimate: { minimum: { unit: 'business_day', value: 4 }, maximum: { unit: 'business_day', value: 9 } },
        },
      },
    },
    line_items: Object.fromEntries(
      items.map((i, n) => [
        n,
        {
          quantity: i.qty,
          price_data: {
            currency: 'usd',
            unit_amount: CATALOG[i.slug].price,
            product_data: {
              name: CATALOG[i.slug].name,
              images: { 0: origin + CATALOG[i.slug].image },
              metadata: { sku: CATALOG[i.slug].sku, slug: i.slug },
            },
          },
        },
      ])
    ),
    metadata: { cart: items.map((i) => `${i.slug}:${i.qty}`).join(',') },
  };
  if (env.STRIPE_AUTOMATIC_TAX === 'true') params.automatic_tax = { enabled: 'true' };

  try {
    const session = await stripe(env, 'POST', 'checkout/sessions', params);
    return json({ url: session.url });
  } catch (e) {
    console.error('checkout', e.message);
    return json({ error: 'We could not start checkout.' }, 502);
  }
}

// ---------- owner notifications (sent through mail.js notifyOwner) ----------
const usd = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);

async function emailNewOrder(env, orderNumber, o, items) {
  const ship = [o.ship_name, o.ship_line1, o.ship_line2, `${o.ship_city}, ${o.ship_state} ${o.ship_postal}`, o.ship_country].filter((x) => x && x.trim());
  await notifyOwner(env, `New order ${orderNumber}: ${usd(o.total_cents)}`, [
    `New paid order ${orderNumber}`,
    '',
    ...items.map((i) => `${i.quantity} x ${i.name} (${i.sku}) at ${usd(i.unit_price_cents)}`),
    '',
    `Subtotal: ${usd(o.subtotal_cents)}`,
    `Shipping: ${usd(o.shipping_cents)}`,
    `Tax: ${usd(o.tax_cents)}`,
    `Total: ${usd(o.total_cents)}`,
    '',
    'Ship to:',
    ...ship,
    '',
    `Customer: ${o.email}${o.phone ? ', ' + o.phone : ''}`,
    `Stripe payment: ${o.stripe_payment_intent || 'n/a'}`,
    '',
    'The order is now waiting for ShipStation to import it.',
  ]);
}

// ---------- orders ----------
async function recordPaidOrder(env, sessionId) {
  const existing = await env.DB.prepare('SELECT order_number FROM orders WHERE stripe_session_id = ?').bind(sessionId).first();
  if (existing) return existing.order_number;

  const s = await stripe(env, 'GET', `checkout/sessions/${encodeURIComponent(sessionId)}?expand%5B%5D=line_items.data.price.product`);
  // 'no_payment_required' = a $0 order (100% coupon), e.g. Rocktomic's integration test order
  if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return null;

  const ship = s.collected_information?.shipping_details || s.shipping_details || {};
  const addr = ship.address || {};
  const cust = s.customer_details || {};
  const now = new Date().toISOString();

  const res = await env.DB.prepare(
    `INSERT INTO orders (stripe_session_id, stripe_payment_intent, status, email, phone, ship_name, ship_line1, ship_line2, ship_city, ship_state, ship_postal, ship_country,
      subtotal_cents, shipping_cents, tax_cents, total_cents, created_at, updated_at)
     VALUES (?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      s.id, s.payment_intent || null, cust.email || '', cust.phone || '', ship.name || cust.name || '',
      addr.line1 || '', addr.line2 || '', addr.city || '', addr.state || '', addr.postal_code || '', addr.country || 'US',
      s.amount_subtotal || 0, s.total_details?.amount_shipping || 0, s.total_details?.amount_tax || 0, s.amount_total || 0, now, now
    )
    .run();
  const id = res.meta.last_row_id;
  const orderNumber = `VC-${1000 + id}`;

  const stmts = [env.DB.prepare('UPDATE orders SET order_number = ? WHERE id = ?').bind(orderNumber, id)];
  for (const li of s.line_items?.data || []) {
    const meta = li.price?.product?.metadata || {};
    const cat = CATALOG[meta.slug] || {};
    stmts.push(
      env.DB.prepare('INSERT INTO order_items (order_id, sku, name, quantity, unit_price_cents, weight_oz, image) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, meta.sku || cat.sku || '', li.description || cat.name || '', li.quantity, li.price?.unit_amount || 0, cat.weightOz || 0, cat.image || '')
    );
  }
  await env.DB.batch(stmts);

  await emailNewOrder(
    env,
    orderNumber,
    {
      email: cust.email || '', phone: cust.phone || '', ship_name: ship.name || cust.name || '',
      ship_line1: addr.line1 || '', ship_line2: addr.line2 || '', ship_city: addr.city || '', ship_state: addr.state || '',
      ship_postal: addr.postal_code || '', ship_country: addr.country || 'US', stripe_payment_intent: s.payment_intent || '',
      subtotal_cents: s.amount_subtotal || 0, shipping_cents: s.total_details?.amount_shipping || 0,
      tax_cents: s.total_details?.amount_tax || 0, total_cents: s.amount_total || 0,
    },
    (s.line_items?.data || []).map((li) => {
      const meta = li.price?.product?.metadata || {};
      return { quantity: li.quantity, name: li.description || CATALOG[meta.slug]?.name || '', sku: meta.sku || CATALOG[meta.slug]?.sku || '', unit_price_cents: li.price?.unit_amount || 0 };
    })
  );
  return orderNumber;
}

// A refund only cancels the order when the whole charge is refunded. A partial refund (a discount, a
// missing item) leaves the order as is, so it still ships. Either way the owner gets an email.
async function handleRefund(env, charge) {
  const pi = charge.payment_intent;
  if (!pi) return;
  const order = await env.DB.prepare('SELECT order_number, status, total_cents FROM orders WHERE stripe_payment_intent = ?').bind(pi).first();
  if (!order) return;
  const full = charge.refunded === true || (charge.amount_refunded || 0) >= (charge.amount || 0);
  const refunded = usd(charge.amount_refunded);

  if (!full) {
    await notifyOwner(env, `Partial refund on ${order.order_number}: ${refunded}`, [
      `${refunded} of ${usd(charge.amount)} was refunded on order ${order.order_number}.`,
      '',
      `This was a partial refund, so the order stays "${order.status}" and will still ship.`,
      'If items need to be removed from the shipment, change the order in ShipStation.',
    ]);
    return;
  }
  if (order.status === 'paid') {
    await env.DB.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE order_number = ? AND status = 'paid'")
      .bind(new Date().toISOString(), order.order_number)
      .run();
    await notifyOwner(env, `Order ${order.order_number} refunded and cancelled`, [
      `Order ${order.order_number} was fully refunded (${refunded}) and marked cancelled.`,
      '',
      'ShipStation picks up the cancellation on its next check. If the order was already sent to the warehouse, confirm with Rocktomic that it did not ship.',
    ]);
  } else {
    await notifyOwner(env, `Order ${order.order_number} refunded after it shipped`, [
      `Order ${order.order_number} was fully refunded (${refunded}), but its status is "${order.status}", so nothing was changed.`,
    ]);
  }
}

async function stripeWebhook(request, env) {
  const payload = await request.text();
  if (!(await verifyStripeSignature(env, payload, request.headers.get('stripe-signature')))) {
    return new Response('Bad signature', { status: 400 });
  }
  const event = JSON.parse(payload);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await recordPaidOrder(env, event.data.object.id);
  }
  if (event.type === 'charge.refunded') await handleRefund(env, event.data.object);
  return json({ received: true });
}

async function orderLookup(url, env) {
  const sid = url.searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) return json({ error: 'Not found' }, 404);
  try {
    const orderNumber = await recordPaidOrder(env, sid); // idempotent; covers the case where the webhook is still in flight
    return orderNumber ? json({ orderNumber }) : json({ status: 'pending' }, 202);
  } catch (e) {
    console.error('order lookup', e.message);
    return json({ error: 'Not found' }, 404);
  }
}

// ---------- ShipStation Custom Store ----------
// ShipStation polls GET ?action=export&start_date=MM/dd/yyyy HH:mm&end_date=...&page=N
// and posts ?action=shipnotify&order_number=...&carrier=...&tracking_number=...
function shipstationAuthorized(request, url, env) {
  const user = env.SHIPSTATION_USER, pass = env.SHIPSTATION_PASS;
  if (!user || !pass) return false;
  const h = request.headers.get('authorization') || '';
  if (h.startsWith('Basic ')) {
    try {
      const [u, ...rest] = atob(h.slice(6)).split(':');
      if (safeEqual(u, user) && safeEqual(rest.join(':'), pass)) return true;
    } catch { /* fall through */ }
  }
  const qu = url.searchParams.get('SS-UserName'), qp = url.searchParams.get('SS-Password');
  return !!qu && !!qp && safeEqual(qu, user) && safeEqual(qp, pass);
}

const xml = (s) => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const pad = (n) => String(n).padStart(2, '0');
const ssDate = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
function parseSsDate(s) {
  const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  return m ? new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5])) : null;
}

async function shipstationExport(url, env) {
  const PAGE = 100;
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  // ShipStation sends times without a zone. Widen the window by 24h each side; ShipStation de-duplicates by OrderID.
  const start = parseSsDate(url.searchParams.get('start_date')) || new Date(Date.now() - 30 * 864e5);
  const end = parseSsDate(url.searchParams.get('end_date')) || new Date();
  const from = new Date(start.getTime() - 864e5).toISOString();
  const to = new Date(end.getTime() + 864e5).toISOString();

  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE updated_at BETWEEN ? AND ? AND order_number IS NOT NULL').bind(from, to).first()).n;
  const { results: orders } = await env.DB.prepare(
    'SELECT * FROM orders WHERE updated_at BETWEEN ? AND ? AND order_number IS NOT NULL ORDER BY id LIMIT ? OFFSET ?'
  ).bind(from, to, PAGE, (page - 1) * PAGE).all();

  const ids = orders.map((o) => o.id);
  const items = ids.length
    ? (await env.DB.prepare(`SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results
    : [];
  const origin = env.SITE_URL || url.origin;

  const body = orders
    .map((o) => {
      const its = items.filter((i) => i.order_id === o.id);
      return `<Order>
<OrderID>${xml(o.order_number)}</OrderID>
<OrderNumber>${xml(o.order_number)}</OrderNumber>
<OrderDate>${ssDate(o.created_at)}</OrderDate>
<OrderStatus>${xml(o.status)}</OrderStatus>
<LastModified>${ssDate(o.updated_at)}</LastModified>
<ShippingMethod>${xml(o.shipping_cents === 0 ? 'Free USPS Shipping' : 'USPS Shipping')}</ShippingMethod>
<PaymentMethod>${xml('Credit Card')}</PaymentMethod>
<CurrencyCode>USD</CurrencyCode>
<OrderTotal>${(o.total_cents / 100).toFixed(2)}</OrderTotal>
<TaxAmount>${(o.tax_cents / 100).toFixed(2)}</TaxAmount>
<ShippingAmount>${(o.shipping_cents / 100).toFixed(2)}</ShippingAmount>
<CustomerNotes>${xml('')}</CustomerNotes>
<InternalNotes>${xml('')}</InternalNotes>
<Customer>
<CustomerCode>${xml(o.email)}</CustomerCode>
<BillTo><Name>${xml(o.ship_name)}</Name><Email>${xml(o.email)}</Email><Phone>${xml(o.phone)}</Phone></BillTo>
<ShipTo><Name>${xml(o.ship_name)}</Name><Address1>${xml(o.ship_line1)}</Address1><Address2>${xml(o.ship_line2)}</Address2><City>${xml(o.ship_city)}</City><State>${xml(o.ship_state)}</State><PostalCode>${xml(o.ship_postal)}</PostalCode><Country>${xml(o.ship_country)}</Country><Phone>${xml(o.phone)}</Phone></ShipTo>
</Customer>
<Items>${its
        .map(
          (i) => `<Item><SKU>${xml(i.sku)}</SKU><Name>${xml(i.name)}</Name><ImageUrl>${xml(origin + i.image)}</ImageUrl><Weight>${i.weight_oz}</Weight><WeightUnits>Ounces</WeightUnits><Quantity>${i.quantity}</Quantity><UnitPrice>${(i.unit_price_cents / 100).toFixed(2)}</UnitPrice></Item>`
        )
        .join('')}</Items>
</Order>`;
    })
    .join('\n');

  const pages = Math.max(1, Math.ceil(total / PAGE));
  return new Response(`<?xml version="1.0" encoding="utf-8"?>\n<Orders pages="${pages}">\n${body}\n</Orders>`, {
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}

async function shipstationNotify(request, url, env) {
  const orderNumber = url.searchParams.get('order_number');
  let carrier = url.searchParams.get('carrier') || '';
  let tracking = url.searchParams.get('tracking_number') || '';
  const raw = await request.text();
  if (!tracking) tracking = (raw.match(/<TrackingNumber>(?:<!\[CDATA\[)?([^<\]]+)/) || [])[1] || '';
  if (!carrier) carrier = (raw.match(/<Carrier>(?:<!\[CDATA\[)?([^<\]]+)/) || [])[1] || '';
  if (!orderNumber) return new Response('Missing order_number', { status: 400 });
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE orders SET status = 'shipped', carrier = ?, tracking_number = ?, shipped_at = ?, updated_at = ? WHERE order_number = ?")
    .bind(carrier, tracking, now, now, orderNumber)
    .run();
  return new Response('OK');
}

async function shipstation(request, url, env) {
  if (!shipstationAuthorized(request, url, env)) {
    return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Basic realm="ShipStation"' } });
  }
  const action = (url.searchParams.get('action') || '').toLowerCase();
  if (action === 'export') return shipstationExport(url, env);
  if (action === 'shipnotify') return shipstationNotify(request, url, env);
  return new Response('Unknown action', { status: 400 });
}

// ---------- security headers for HTML ----------
function withHeaders(res) {
  const h = new Headers(res.headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('x-frame-options', 'SAMEORIGIN');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if ((h.get('content-type') || '').includes('text/html')) h.set('cache-control', 'public, max-age=300');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async email(message, env) {
    try {
      await handleEmail(message, env);
    } catch (e) {
      // Never lose a customer email: reject so the sender gets a bounce instead of silence
      console.error('email handler', e.stack || e.message);
      message.setReject('Temporary problem receiving this message. Please try again later.');
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Canonical host
    if (url.hostname === 'www.vitalitychews.com') {
      url.hostname = 'vitalitychews.com';
      return Response.redirect(url.toString(), 301);
    }

    try {
      if (url.pathname === '/api/checkout' && request.method === 'POST') return await createCheckout(request, env);
      if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') return await stripeWebhook(request, env);
      if (url.pathname === '/api/order' && request.method === 'GET') return await orderLookup(url, env);
      if (url.pathname === '/api/shipstation') return await shipstation(request, url, env);
      if (url.pathname === '/api/contact' && request.method === 'POST') return await handleContact(request, env);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await handleAdmin(request, env, url);
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(url.pathname, e.stack || e.message);
      return json({ error: 'Server error' }, 500);
    }

    const legacy = legacyRedirect(url);
    if (legacy) return legacy;

    // One canonical form per page: permanent redirect to the trailing-slash URL
    if (!url.pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(url.pathname)) {
      url.pathname += '/';
      return Response.redirect(url.toString(), 301);
    }

    return withHeaders(await env.ASSETS.fetch(request));
  },
};
