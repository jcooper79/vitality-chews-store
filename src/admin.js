// Admin portal at /admin: customer inbox (read + reply from hello@), new email, recent orders.
// Sign-in is a one-time link emailed to ORDER_NOTIFY_TO (no password to leak). Sessions are random tokens
// stored hashed in D1 and sent as an HttpOnly cookie.
import { esc, sha256hex, randomToken, nowIso, rateLimited, notifyOwner, sendToCustomer, startThread, adminBase } from './mail.js';

const COOKIE = 'vc_admin';
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

const SECURITY = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY, ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, ...SECURITY, ...headers } });
const fmtDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const usd = (c) => '$' + (Number(c || 0) / 100).toFixed(2);
const safeNext = (n) => (typeof n === 'string' && /^\/admin(\/[\w\-/?=&%.]*)?$/.test(n) ? n : '/admin/');

function sameSitePost(request, url) {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser client; the SameSite=Lax session cookie still guards actions
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

function cookieValue(request) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

async function currentSession(request, env) {
  const tok = cookieValue(request);
  if (!tok) return null;
  const row = await env.DB.prepare("SELECT token_hash FROM admin_tokens WHERE token_hash = ? AND kind = 'session' AND expires_at > ?")
    .bind(await sha256hex(tok), nowIso()).first();
  return row ? row.token_hash : null;
}

function page(title, body, { nav = true, unread = 0 } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)} | Vitality Chews admin</title><link rel="icon" href="/img/icon-32.png">
<style>
:root{--g:#229b5e;--gd:#17774a;--deep:#0d3b26;--ink:#13241b;--muted:#66766d;--line:#e3ebe6;--soft:#e8f6ee;--cream:#fbf8f1}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--cream)}
a{color:var(--gd)}header{background:var(--deep);color:#fff}header .in{max-width:1100px;margin:0 auto;padding:12px 16px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header img{height:30px}header nav{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}header nav a,header nav button{color:#e6f4ec;text-decoration:none;font:600 15px system-ui;padding:7px 12px;border-radius:999px;background:none;border:0;cursor:pointer}
header nav a:hover,header nav button:hover{background:rgba(255,255,255,.12)}.badge{background:#ffcf4a;color:var(--ink);border-radius:999px;padding:1px 8px;font-size:12px;margin-left:4px}
main{max-width:1100px;margin:0 auto;padding:24px 16px 60px}h1{font-size:26px;margin:0 0 16px}h2{font-size:19px}
.card{background:#fff;border-radius:16px;box-shadow:0 0 0 1px var(--line);padding:18px;margin-bottom:14px}
.btn{display:inline-block;background:var(--g);color:#fff;border:0;border-radius:999px;padding:10px 20px;font:700 15px system-ui;cursor:pointer;text-decoration:none}.btn:hover{background:var(--gd);color:#fff}
.btn.ghost{background:#fff;color:var(--ink);box-shadow:0 0 0 2px var(--line)}.btn.ghost:hover{background:var(--soft)}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}.tabs a{padding:6px 14px;border-radius:999px;text-decoration:none;color:var(--ink);background:#fff;box-shadow:0 0 0 1px var(--line);font-weight:600;font-size:14px}.tabs a.on{background:var(--ink);color:#fff}
.list a.row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:14px 16px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}.list a.row:hover{background:var(--soft)}
.list .row.unread .who,.list .row.unread .subj{font-weight:700}.list .row.unread .who::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--g);margin-right:8px}
.list{background:#fff;border-radius:16px;box-shadow:0 0 0 1px var(--line);overflow:hidden}.muted{color:var(--muted)}.small{font-size:13px}
.msg{background:#fff;border-radius:16px;box-shadow:0 0 0 1px var(--line);padding:16px 18px;margin-bottom:12px}.msg.out{background:var(--soft);margin-left:min(8%,60px)}
.msg .meta{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-bottom:8px}.msg pre{white-space:pre-wrap;word-wrap:break-word;font:inherit;margin:0}
.atts{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}.atts a{font-size:13px;background:var(--cream);padding:4px 10px;border-radius:8px;text-decoration:none}
textarea,input[type=text],input[type=email]{width:100%;font:inherit;padding:10px 12px;border:2px solid var(--line);border-radius:12px;background:#fff}textarea{min-height:160px}
label{display:block;font-weight:600;margin:10px 0 4px}.row2{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
.flash{background:#dff3e7;border-radius:12px;padding:10px 14px;margin-bottom:14px;font-weight:600}.err{background:#fde8e6;color:#8a1c12}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 0 0 1px var(--line)}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}th{background:var(--soft)}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;background:var(--soft);color:var(--gd)}.pill.cancelled{background:#fde8e6;color:#8a1c12}.pill.shipped{background:#e3effd;color:#1d4f91}.pill.closed{background:#eee;color:#555}
.center{text-align:center}.narrow{max-width:440px;margin:60px auto}
@media(max-width:640px){.hide-sm{display:none}.msg.out{margin-left:0}}
</style></head><body>
<header><div class="in"><a href="/admin/"><img src="/img/logo-h-white.webp" alt="Vitality Chews"></a>${
    nav
      ? `<nav><a href="/admin/">Inbox${unread ? `<span class="badge">${unread}</span>` : ''}</a><a href="/admin/compose">New email</a><a href="/admin/orders">Orders</a><form method="post" action="/admin/logout" style="margin:0"><button>Sign out</button></form></nav>`
      : ''
  }</div></header><main>${body}</main></body></html>`;
}

async function unreadCount(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM threads WHERE unread = 1 AND status = 'open'").first();
  return r.n;
}

// ---------- sign-in ----------
function loginPage(next, msg = '') {
  return html(page('Sign in', `<div class="card narrow center">
<h1>Admin sign-in</h1>
${msg ? `<div class="flash">${msg}</div>` : `<p class="muted">We will email a one-time sign-in link to the owner's address. It works for ${LINK_MINUTES} minutes.</p>`}
<form method="post" action="/admin/login"><input type="hidden" name="next" value="${esc(next)}"><button class="btn">Email me a sign-in link</button></form>
</div>`, { nav: false }));
}

async function sendLoginLink(request, env, form) {
  const next = safeNext(form.get('next'));
  const done = 'If the owner address is set up, a sign-in link is on its way. Check your email.';
  if (await rateLimited(env, 'login', 5, 15)) return loginPage(next, 'Too many sign-in requests. Wait a few minutes and try again.');
  if (!env.ORDER_NOTIFY_TO || !env.EMAIL) return loginPage(next, done);
  const token = randomToken();
  const now = new Date();
  await env.DB.prepare("INSERT INTO admin_tokens (token_hash, kind, expires_at, created_at) VALUES (?, 'login', ?, ?)")
    .bind(await sha256hex(token), new Date(now.getTime() + LINK_MINUTES * 60_000).toISOString(), now.toISOString()).run();
  const base = adminBase(env) || new URL(request.url).origin;
  await notifyOwner(env, 'Your Vitality Chews admin sign-in link', [
    `Use the button below to sign in to the store admin. The link works once and expires in ${LINK_MINUTES} minutes.`,
    '',
    'If you did not ask for this, ignore this email.',
  ], { from: `inbox@${env.MAIL_DOMAIN || 'vitalitychews.com'}`, fromName: 'Vitality Chews Admin', button: { label: 'Sign in to admin', href: `${base}/admin/auth?t=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}` } });
  return loginPage(next, done);
}

// GET shows a button (so email link scanners cannot use up the one-time link); POST signs in.
function confirmPage(token, next) {
  return html(page('Sign in', `<div class="card narrow center"><h1>Finish signing in</h1>
<form method="post" action="/admin/auth"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="next" value="${esc(next)}"><button class="btn">Sign in</button></form></div>`, { nav: false }));
}

async function completeLogin(env, form) {
  const token = String(form.get('t') || '');
  const next = safeNext(form.get('next'));
  const hash = await sha256hex(token);
  const now = nowIso();
  const row = await env.DB.prepare("SELECT token_hash FROM admin_tokens WHERE token_hash = ? AND kind = 'login' AND used_at IS NULL AND expires_at > ?").bind(hash, now).first();
  if (!token || !row) return loginPage(next, 'That sign-in link has expired or was already used. Request a new one.');
  await env.DB.prepare('UPDATE admin_tokens SET used_at = ? WHERE token_hash = ?').bind(now, hash).run();
  const session = randomToken();
  await env.DB.prepare("INSERT INTO admin_tokens (token_hash, kind, expires_at, created_at) VALUES (?, 'session', ?, ?)")
    .bind(await sha256hex(session), new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(), now).run();
  await env.DB.prepare('DELETE FROM admin_tokens WHERE expires_at < ?').bind(now).run();
  return redirect(next, { 'set-cookie': `${COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
}

// ---------- pages ----------
async function inbox(env, url) {
  const status = ['open', 'closed', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
  const where = status === 'all' ? '' : 'WHERE t.status = ?';
  const stmt = env.DB.prepare(
    `SELECT t.*, (SELECT body_text FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS preview,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS n
     FROM threads t ${where} ORDER BY t.last_message_at DESC LIMIT 200`
  );
  const { results } = await (status === 'all' ? stmt : stmt.bind(status)).all();
  const rows = results.length
    ? results.map((t) => `<a class="row${t.unread ? ' unread' : ''}" href="/admin/thread/${t.id}">
  <span class="who">${esc(t.customer_name || t.customer_email)} <span class="muted small hide-sm">${t.customer_name ? esc(t.customer_email) : ''}</span></span>
  <span class="muted small">${fmtDate(t.last_message_at)}</span>
  <span class="subj">${esc(t.subject || '(no subject)')} ${t.n > 1 ? `<span class="muted small">(${t.n})</span>` : ''} ${t.status === 'closed' ? '<span class="pill closed">closed</span>' : ''}</span>
  <span class="muted small">${t.source === 'contact-form' ? 'Contact form' : esc(t.mailbox)}</span>
  <span class="muted small" style="grid-column:1/-1">${esc((t.preview || '').replace(/\s+/g, ' ').slice(0, 140))}</span></a>`).join('')
    : '<p class="muted" style="padding:18px">Nothing here.</p>';
  return html(page('Inbox', `<h1>Inbox</h1>
<div class="tabs">${['open', 'closed', 'all'].map((s) => `<a href="/admin/?status=${s}" class="${s === status ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</a>`).join('')}</div>
<div class="list">${rows}</div>`, { unread: await unreadCount(env) }));
}

async function threadView(env, id, url) {
  const t = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first();
  if (!t) return html(page('Not found', '<h1>Conversation not found</h1>'), 404);
  const { results: msgs } = await env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').bind(id).all();
  const { results: atts } = await env.DB.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?`).bind(id).all();
  if (t.unread) await env.DB.prepare('UPDATE threads SET unread = 0 WHERE id = ?').bind(id).run();
  const orders = (await env.DB.prepare('SELECT order_number, status, total_cents, created_at, tracking_number FROM orders WHERE email = ? ORDER BY id DESC LIMIT 5').bind(t.customer_email).all()).results;
  const via = { 'email-reply': 'sent by email reply', admin: 'sent from admin', 'contact-form': 'contact form', inbound: '' };
  const flash = url.searchParams.get('sent') ? '<div class="flash">Reply sent.</div>' : url.searchParams.get('error') ? `<div class="flash err">${esc(url.searchParams.get('error'))}</div>` : '';
  const body = `${flash}<p class="small"><a href="/admin/">&larr; Inbox</a></p>
<h1>${esc(t.subject || '(no subject)')}</h1>
<p class="muted">${esc(t.customer_name)} &lt;${esc(t.customer_email)}&gt; &middot; ${t.source === 'contact-form' ? 'contact form' : esc(t.mailbox)} &middot; <span class="pill ${t.status}">${t.status}</span></p>
${orders.length ? `<div class="card small"><strong>Orders from this email:</strong> ${orders.map((o) => `${esc(o.order_number)} (${usd(o.total_cents)}, ${esc(o.status)}${o.tracking_number ? ', tracking ' + esc(o.tracking_number) : ''})`).join(' &middot; ')}</div>` : ''}
${msgs.map((m) => `<div class="msg ${m.direction}"><div class="meta"><span><strong>${m.direction === 'out' ? 'Vitality Chews' : esc(m.from_name || m.from_email)}</strong>${m.direction === 'in' ? ` &lt;${esc(m.from_email)}&gt;` : ''} ${via[m.sent_via] ? `&middot; ${via[m.sent_via]}` : ''}${m.auto ? ' &middot; automated' : ''}</span><span>${fmtDate(m.created_at)}</span></div>
<pre>${esc(m.body_text)}</pre>${(() => { const a = atts.filter((x) => x.message_id === m.id); return a.length ? `<div class="atts">${a.map((x) => `<a href="/admin/att/${x.id}" target="_blank" rel="noopener">${esc(x.filename)} (${Math.ceil(x.size / 1024)} KB)</a>`).join('')}</div>` : ''; })()}</div>`).join('')}
<form class="card" method="post" action="/admin/thread/${id}/reply">
<label for="body">Reply to ${esc(t.customer_name || t.customer_email)} <span class="muted small">(sent from ${esc(env.SUPPORT_EMAIL || 'hello@vitalitychews.com')})</span></label>
<textarea id="body" name="body" required></textarea>
<div class="row2"><button class="btn">Send reply</button><label style="margin:0;font-weight:500"><input type="checkbox" name="close" value="1"> Close after sending</label></div>
</form>
<form method="post" action="/admin/thread/${id}/status"><input type="hidden" name="status" value="${t.status === 'open' ? 'closed' : 'open'}"><button class="btn ghost">${t.status === 'open' ? 'Close conversation' : 'Reopen conversation'}</button></form>`;
  return html(page(t.subject || 'Conversation', body, { unread: await unreadCount(env) }));
}

async function composePage(env, url, err = '') {
  return html(page('New email', `<p class="small"><a href="/admin/">&larr; Inbox</a></p><h1>New email</h1>${err ? `<div class="flash err">${esc(err)}</div>` : ''}
<form class="card" method="post" action="/admin/compose">
<label for="to">To</label><input type="email" id="to" name="to" required value="${esc(url.searchParams.get('to') || '')}">
<label for="name">Name <span class="muted small">(optional)</span></label><input type="text" id="name" name="name">
<label for="subject">Subject</label><input type="text" id="subject" name="subject" required>
<label for="body">Message</label><textarea id="body" name="body" required></textarea>
<div class="row2"><button class="btn">Send</button><span class="muted small">Sent from ${esc(env.SUPPORT_EMAIL || 'hello@vitalitychews.com')}. Replies come back to this inbox.</span></div>
</form>`, { unread: await unreadCount(env) }));
}

async function ordersPage(env, url) {
  const { results } = await env.DB.prepare(
    `SELECT o.*, (SELECT GROUP_CONCAT(i.quantity || ' x ' || i.sku, ', ') FROM order_items i WHERE i.order_id = o.id) AS items FROM orders o ORDER BY o.id DESC LIMIT 100`
  ).all();
  const flash = url.searchParams.get('cancelled') ? `<div class="flash">Order ${esc(url.searchParams.get('cancelled'))} cancelled. ShipStation picks this up on its next check. No money was refunded; refund in Stripe if needed.</div>` : '';
  return html(page('Orders', `<h1>Orders</h1>${flash}${results.length ? `<table><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th class="hide-sm">Items</th><th>Total</th><th>Status</th></tr></thead><tbody>${results
    .map((o) => `<tr><td><strong>${esc(o.order_number || '')}</strong></td><td>${fmtDate(o.created_at)}</td><td>${esc(o.ship_name)}<br><a class="small" href="/admin/compose?to=${encodeURIComponent(o.email)}">${esc(o.email)}</a></td><td class="hide-sm">${esc(o.items || '')}</td><td>${usd(o.total_cents)}</td><td><span class="pill ${esc(o.status)}">${esc(o.status)}</span>${o.tracking_number ? `<br><span class="small">${esc(o.carrier || '')} ${esc(o.tracking_number)}</span>` : ''}${o.status === 'paid' ? `<form method="post" action="/admin/orders/${o.id}/cancel" style="margin-top:6px"><button class="btn ghost" style="padding:4px 10px;font-size:12px" title="Stops fulfillment. Does not refund.">Cancel order</button></form>` : ''}</td></tr>`)
    .join('')}</tbody></table>` : '<p class="muted">No orders yet.</p>'}`, { unread: await unreadCount(env) }));
}

async function attachment(env, id) {
  const a = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first();
  const obj = a && env.MAIL_FILES ? await env.MAIL_FILES.get(a.r2_key) : null;
  if (!obj) return html(page('Not found', '<h1>Attachment not found</h1>'), 404);
  const inline = /^image\/(png|jpe?g|gif|webp)$/i.test(a.content_type) || a.content_type === 'application/pdf';
  return new Response(obj.body, {
    headers: {
      ...SECURITY,
      'content-type': inline ? a.content_type : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${a.filename.replace(/["\\\r\n]/g, '_')}"`,
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

// ---------- router ----------
export async function handleAdmin(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/admin';
  const method = request.method;

  // Cross-site form posts are refused. Browsers send Sec-Fetch-Site; with Referrer-Policy no-referrer
  // they may send "Origin: null", so the Origin header is only a fallback for clients without Sec-Fetch-Site.
  if (method === 'POST' && !sameSitePost(request, url)) return html('Forbidden', 403);
  const form = method === 'POST' ? await request.formData().catch(() => new FormData()) : null;

  if (path === '/admin/login') return method === 'POST' ? sendLoginLink(request, env, form) : loginPage(safeNext(url.searchParams.get('next')));
  if (path === '/admin/auth') return method === 'POST' ? completeLogin(env, form) : confirmPage(url.searchParams.get('t') || '', safeNext(url.searchParams.get('next')));

  const session = await currentSession(request, env);
  if (!session) {
    if (method === 'GET') return redirect(`/admin/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return html('Not signed in', 401);
  }

  if (path === '/admin/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM admin_tokens WHERE token_hash = ?').bind(session).run();
    return redirect('/admin/login', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  if (path === '/admin' && method === 'GET') return inbox(env, url);
  if (path === '/admin/orders' && method === 'GET') return ordersPage(env, url);
  let om;
  if ((om = path.match(/^\/admin\/orders\/(\d+)\/cancel$/)) && method === 'POST') {
    const o = await env.DB.prepare('SELECT order_number, status FROM orders WHERE id = ?').bind(Number(om[1])).first();
    if (o && o.status === 'paid') {
      await env.DB.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'paid'").bind(nowIso(), Number(om[1])).run();
    }
    return redirect(`/admin/orders?cancelled=${encodeURIComponent(o?.order_number || '')}`);
  }
  if (path === '/admin/compose') {
    if (method === 'GET') return composePage(env, url);
    const to = String(form.get('to') || '').trim();
    const subject = String(form.get('subject') || '').trim();
    const body = String(form.get('body') || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to) || !subject || !body.trim()) return composePage(env, url, 'Fill in a valid address, a subject and a message.');
    try {
      const id = await startThread(env, { to, name: String(form.get('name') || '').trim(), subject, body });
      return redirect(`/admin/thread/${id}?sent=1`);
    } catch (e) {
      return composePage(env, url, `Not sent: ${e.message}`);
    }
  }
  let m;
  if ((m = path.match(/^\/admin\/thread\/(\d+)$/)) && method === 'GET') return threadView(env, Number(m[1]), url);
  if ((m = path.match(/^\/admin\/thread\/(\d+)\/reply$/)) && method === 'POST') {
    const id = Number(m[1]);
    try {
      await sendToCustomer(env, id, String(form.get('body') || ''), 'admin');
      if (form.get('close')) await env.DB.prepare("UPDATE threads SET status = 'closed' WHERE id = ?").bind(id).run();
      return redirect(`/admin/thread/${id}?sent=1`);
    } catch (e) {
      return redirect(`/admin/thread/${id}?error=${encodeURIComponent('Not sent: ' + e.message)}`);
    }
  }
  if ((m = path.match(/^\/admin\/thread\/(\d+)\/status$/)) && method === 'POST') {
    const status = form.get('status') === 'closed' ? 'closed' : 'open';
    await env.DB.prepare('UPDATE threads SET status = ? WHERE id = ?').bind(status, Number(m[1])).run();
    return redirect(status === 'closed' ? '/admin/' : `/admin/thread/${m[1]}`);
  }
  if ((m = path.match(/^\/admin\/att\/(\d+)$/)) && method === 'GET') return attachment(env, Number(m[1]));
  return html(page('Not found', '<h1>Not found</h1>'), 404);
}
