// Bridge to the WordPress/WooCommerce store that Rocktomic's ShipStation is connected to.
//
// Rocktomic only imports orders from WooCommerce, so every paid order on this storefront is copied into
// WooCommerce as a paid "processing" order (same SKUs, address and totals). Rocktomic's ShipStation pulls it
// from there. When they ship, ShipStation marks the WooCommerce order "completed" and adds an order note with
// the tracking number; the every-5-minute cron copies that back here. Cancellations here are pushed to
// WooCommerce so an unshipped order is not fulfilled.
//
// Config: WC_URL (var, e.g. https://vitalitychews.com), WC_CONSUMER_KEY / WC_CONSUMER_SECRET (secrets, a
// WooCommerce REST API key with Read/Write). Without the secrets every function is a no-op.
import { notifyOwner, nowIso } from './mail.js';

const configured = (env) => !!(env.WC_URL && env.WC_CONSUMER_KEY && env.WC_CONSUMER_SECRET);
const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);

async function wc(env, method, path, body) {
  const res = await fetch(`${env.WC_URL.replace(/\/$/, '')}/wp-json/wc/v3/${path}`, {
    method,
    headers: {
      authorization: 'Basic ' + btoa(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`),
      'content-type': 'application/json',
      'user-agent': 'VitalityChewsStorefront/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) throw new Error(`WooCommerce ${method} ${path.split('?')[0]}: ${res.status} ${data?.message || text.slice(0, 200)}`);
  return data;
}

async function productIds(env, skus) {
  const map = {};
  for (const sku of [...new Set(skus)]) {
    const found = await wc(env, 'GET', `products?sku=${encodeURIComponent(sku)}&per_page=5`);
    const p = (found || []).find((x) => x.sku === sku);
    if (!p) throw new Error(`No WooCommerce product with SKU ${sku}`);
    map[sku] = p.id;
  }
  return map;
}

function splitName(name = '') {
  const parts = name.trim().split(/\s+/);
  return { first_name: parts.shift() || '', last_name: parts.join(' ') };
}

// Build the WooCommerce order from what we stored. Discounts (promotion codes) become a negative fee so the
// WooCommerce total matches what the customer paid.
export function buildWooOrder(o, items, ids) {
  const name = splitName(o.ship_name);
  const address = {
    ...name,
    address_1: o.ship_line1,
    address_2: o.ship_line2,
    city: o.ship_city,
    state: o.ship_state,
    postcode: o.ship_postal,
    country: o.ship_country || 'US',
  };
  const itemsCents = items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0);
  const discount = itemsCents + (o.shipping_cents || 0) + (o.tax_cents || 0) - (o.total_cents || 0);
  return {
    status: 'processing',
    set_paid: true,
    payment_method: 'stripe',
    payment_method_title: 'Card (vitalitychews.com checkout)',
    transaction_id: o.stripe_payment_intent || '',
    billing: { ...address, email: o.email, phone: o.phone },
    shipping: { ...address, phone: o.phone },
    line_items: items.map((i) => ({
      product_id: ids[i.sku],
      sku: i.sku,
      quantity: i.quantity,
      subtotal: dollars(i.unit_price_cents * i.quantity),
      total: dollars(i.unit_price_cents * i.quantity),
    })),
    shipping_lines: [{ method_id: 'flat_rate', method_title: o.shipping_cents ? 'USPS shipping' : 'Free shipping', total: dollars(o.shipping_cents) }],
    fee_lines: discount > 0 ? [{ name: 'Discount', total: `-${dollars(discount)}`, tax_status: 'none' }] : [],
    meta_data: [
      { key: '_vc_order_number', value: o.order_number },
      { key: '_vc_source', value: 'vitalitychews.com storefront' },
    ],
  };
}

// Copy one paid order into WooCommerce. Safe to call repeatedly: does nothing once wc_order_id is set.
export async function syncOrderToWoo(env, orderId) {
  if (!configured(env)) return null;
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!o || o.wc_order_id || o.status !== 'paid' || !o.order_number) return o?.wc_order_number || null;
  // Claim the order so the webhook and the cron cannot both create it
  const claim = await env.DB.prepare("UPDATE orders SET wc_sync_error = 'syncing', wc_synced_at = ? WHERE id = ? AND wc_order_id IS NULL AND (wc_sync_error IS NULL OR wc_sync_error != 'syncing' OR wc_synced_at < ?)")
    .bind(nowIso(), orderId, new Date(Date.now() - 10 * 60_000).toISOString()).run();
  if (!claim.meta.changes) return null;
  try {
    const { results: items } = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(orderId).all();
    const ids = await productIds(env, items.map((i) => i.sku));
    const created = await wc(env, 'POST', 'orders', buildWooOrder(o, items, ids));
    await env.DB.prepare('UPDATE orders SET wc_order_id = ?, wc_order_number = ?, wc_sync_error = NULL, wc_synced_at = ? WHERE id = ?')
      .bind(created.id, String(created.number || created.id), nowIso(), orderId).run();
    return String(created.number || created.id);
  } catch (e) {
    console.error('woo sync', o.order_number, e.message);
    const first = !o.wc_sync_error || o.wc_sync_error === 'syncing';
    await env.DB.prepare('UPDATE orders SET wc_sync_error = ?, wc_synced_at = ? WHERE id = ?').bind(e.message.slice(0, 500), nowIso(), orderId).run();
    if (first) {
      await notifyOwner(env, `Order ${o.order_number} did not reach WooCommerce yet`, [
        `Order ${o.order_number} was paid but could not be copied to WooCommerce, so Rocktomic has not received it.`,
        '',
        `Error: ${e.message}`,
        '',
        'The store retries every 5 minutes. You will not get another email for this order unless you check the admin Orders page.',
      ]);
    }
    return null;
  }
}

// Cancel the WooCommerce copy (when the order is refunded or cancelled here)
export async function cancelInWoo(env, orderId) {
  if (!configured(env)) return;
  const o = await env.DB.prepare('SELECT order_number, wc_order_id FROM orders WHERE id = ?').bind(orderId).first();
  if (!o?.wc_order_id) return;
  try {
    const cur = await wc(env, 'GET', `orders/${o.wc_order_id}`);
    if (cur.status === 'completed') {
      await notifyOwner(env, `Order ${o.order_number} was already shipped`, [
        `You cancelled order ${o.order_number}, but WooCommerce order #${cur.number} is already marked shipped by Rocktomic. Nothing was changed in WooCommerce.`,
      ]);
      return;
    }
    await wc(env, 'PUT', `orders/${o.wc_order_id}`, { status: 'cancelled' });
  } catch (e) {
    console.error('woo cancel', o.order_number, e.message);
    await notifyOwner(env, `Cancel order ${o.order_number} in WooCommerce`, [
      `Order ${o.order_number} was cancelled here, but the WooCommerce copy (ID ${o.wc_order_id}) could not be cancelled automatically: ${e.message}`,
      '',
      'Cancel it by hand in WooCommerce so Rocktomic does not ship it.',
    ]);
  }
}

// Tracking from the ShipStation plugin's order note, e.g.
// "2 items shipped via USPS on November 9, 2026 with tracking number 9405511206217260972924."
export function trackingFromNotes(notes = [], meta = []) {
  const items = meta.find((m) => m.key === '_wc_shipment_tracking_items')?.value;
  if (Array.isArray(items) && items[0]?.tracking_number) return { carrier: items[0].tracking_provider || items[0].custom_tracking_provider || '', tracking: items[0].tracking_number };
  for (const n of notes) {
    const t = String(n.note || '').replace(/<[^>]+>/g, ' ');
    let m = t.match(/shipped via (.+?) on .+? with tracking number\s*:?\s*([A-Za-z0-9]{8,})/i);
    if (m) return { carrier: m[1].trim(), tracking: m[2] };
    m = t.match(/tracking (?:number|#)\s*:?\s*([A-Za-z0-9]{8,})/i);
    if (m) return { carrier: '', tracking: m[1] };
  }
  return null;
}

// Cron: retry unsynced orders, then copy shipped/cancelled status back from WooCommerce
export async function runWooSync(env) {
  if (!configured(env)) return;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const { results: pending } = await env.DB.prepare("SELECT id FROM orders WHERE status = 'paid' AND wc_order_id IS NULL AND order_number IS NOT NULL AND created_at > ? LIMIT 20").bind(weekAgo).all();
  for (const p of pending) await syncOrderToWoo(env, p.id);

  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const { results: open } = await env.DB.prepare("SELECT id, order_number, wc_order_id FROM orders WHERE status = 'paid' AND wc_order_id IS NOT NULL AND created_at > ? LIMIT 50").bind(since).all();
  if (!open.length) return;
  let remote;
  try {
    remote = await wc(env, 'GET', `orders?include=${open.map((o) => o.wc_order_id).join(',')}&per_page=50`);
  } catch (e) {
    console.error('woo status pull', e.message);
    return;
  }
  for (const r of remote || []) {
    const o = open.find((x) => x.wc_order_id === r.id);
    if (!o) continue;
    const now = nowIso();
    if (r.status === 'completed') {
      let t = trackingFromNotes([], r.meta_data || []);
      if (!t) {
        try { t = trackingFromNotes(await wc(env, 'GET', `orders/${r.id}/notes`)); } catch (e) { console.error('woo notes', e.message); }
      }
      await env.DB.prepare("UPDATE orders SET status = 'shipped', carrier = ?, tracking_number = ?, shipped_at = ?, updated_at = ? WHERE id = ? AND status = 'paid'")
        .bind(t?.carrier || '', t?.tracking || '', now, now, o.id).run();
    } else if (['cancelled', 'refunded', 'failed', 'trash'].includes(r.status)) {
      await env.DB.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'paid'").bind(now, o.id).run();
      await notifyOwner(env, `Order ${o.order_number} was cancelled in WooCommerce`, [
        `WooCommerce order #${r.number} (our ${o.order_number}) is now "${r.status}", so it was marked cancelled here too.`,
        '',
        'No refund was made. If the customer should get their money back, refund the payment in Stripe.',
      ]);
    }
  }
}
