// Customer email for vitalitychews.com, handled entirely on Cloudflare.
//
// Inbound:  Email Routing (catch-all) -> email() handler -> stored in D1 (threads/messages) + attachments in R2.
//           The owner gets a notice at ORDER_NOTIFY_TO. It comes from inbox@ with Reply-To reply+<thread>-<sig>@,
//           so hitting Reply never exposes the owner's address to the customer.
// Owner reply by email: mail to reply+<thread>-<sig>@ is accepted only from ORDER_NOTIFY_TO with a passing
//           DKIM/DMARC result for that domain. Quoted text and signatures are stripped and only the new text is
//           sent to the customer from hello@.
// Outbound: admin portal replies and email replies go out from SUPPORT_EMAIL with Reply-To hello+<thread>-<sig>@
//           so the customer's answer lands back in the same thread.
import PostalMime from 'postal-mime';

export const MARKER = '##- Reply above this line to answer the customer -##';
const MAX_BODY = 100_000;
const MAX_ATTACHMENT = 20 * 1024 * 1024;

// ---------- small helpers ----------
const enc = new TextEncoder();
export const nowIso = () => new Date().toISOString();
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const domainOf = (env) => (env.MAIL_DOMAIN || 'vitalitychews.com').toLowerCase();
const supportEmail = (env) => (env.SUPPORT_EMAIL || `hello@${domainOf(env)}`).toLowerCase();
export const adminBase = (env) => (env.ADMIN_BASE_URL || env.SITE_URL || '').replace(/\/$/, '');
const ownerEmail = (env) => (env.ORDER_NOTIFY_TO || '').trim().toLowerCase();

// Thread tags: "<id>-<12 hex>" signed with INBOX_SECRET, used in plus-addresses
async function tagFor(env, kind, threadId) {
  return `${threadId}-${(await hmacHex(env.INBOX_SECRET || 'unset', `${kind}:${threadId}`)).slice(0, 12)}`;
}
async function readTag(env, kind, tag) {
  const m = /^(\d+)-([0-9a-f]{12})$/.exec(tag || '');
  if (!m || !env.INBOX_SECRET) return null;
  return (await tagFor(env, kind, m[1])) === tag ? Number(m[1]) : null;
}
export const ownerReplyAddress = async (env, threadId) => `reply+${await tagFor(env, 'owner', threadId)}@${domainOf(env)}`;
const customerReplyAddress = async (env, threadId) => {
  const [local, dom] = supportEmail(env).split('@');
  return `${local}+${await tagFor(env, 'customer', threadId)}@${dom}`;
};

export async function rateLimited(env, bucket, max, minutes) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND created_at > ?').bind(bucket, since).first();
  if (n >= max) return true;
  await env.DB.prepare('INSERT INTO rate_events (bucket, created_at) VALUES (?, ?)').bind(bucket, nowIso()).run();
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rate_events WHERE created_at < ?').bind(new Date(Date.now() - 864e5).toISOString()).run();
  return false;
}

export function htmlToText(html = '') {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Keep only what the owner typed: cut at the marker, "On ... wrote:", quoted lines, forwarded headers, signatures.
export function stripReply(text = '') {
  const lines = text.replace(/\r/g, '').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const two = `${l} ${(lines[i + 1] || '').trim()}`;
    if (
      l.includes('Reply above this line') ||
      /^>/.test(l) ||
      /^On\s.+wrote:$/i.test(l) ||
      (/^On\s/i.test(l) && /wrote:$/i.test(two)) ||
      /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l) ||
      /^_{8,}$/.test(l) ||
      (/^From:\s/i.test(l) && lines.slice(i + 1, i + 5).some((x) => /^(Sent|Date|To|Subject):\s/i.test(x.trim())))
    ) { cut = i; break; }
  }
  let out = lines.slice(0, cut);
  const sig = out.findIndex((l) => l === '-- ' || l.trim() === '--');
  if (sig >= 0) out = out.slice(0, sig);
  let body = out.join('\n').trim();
  body = body.replace(/\n*(Sent from my (iPhone|iPad|Android|phone)|Get Outlook for (iOS|Android)|Sent from Gmail Mobile|Sent from Yahoo Mail.*)\s*$/i, '').trim();
  return body;
}

function isAutomated(headers, from) {
  const auto = (headers.get('auto-submitted') || '').toLowerCase();
  const prec = (headers.get('precedence') || '').toLowerCase();
  return (
    (auto && auto !== 'no') ||
    ['bulk', 'list', 'junk', 'auto_reply'].includes(prec) ||
    headers.has('list-unsubscribe') ||
    headers.has('x-autoreply') ||
    /^(mailer-daemon|postmaster|no-?reply|bounce)/i.test(from || '')
  );
}

// DKIM or DMARC pass for the owner's domain, as recorded by Cloudflare Email Routing
function ownerAuthPassed(headers, ownerDomain) {
  const ar = (headers.get('authentication-results') || '').toLowerCase();
  const d = ownerDomain.replace(/\./g, '\\.');
  return new RegExp(`dkim=pass[^;]*header\\.d=${d}\\b`).test(ar) || new RegExp(`dmarc=pass[^;]*header\\.from=${d}\\b`).test(ar);
}

const normId = (id) => {
  if (!id) return null;
  const s = String(id).trim();
  if (!s) return null;
  return s.startsWith('<') ? s : `<${s}>`;
};

// ---------- sending ----------
async function sendEmail(env, msg) {
  if (!env.EMAIL) throw new Error('EMAIL binding is not configured');
  return env.EMAIL.send(msg);
}

// Owner notifications (orders, refunds, system notes). Never includes a Reply-To that reaches a customer.
export async function notifyOwner(env, subject, lines, extra = {}) {
  if (!env.EMAIL || !ownerEmail(env)) {
    console.log('owner email skipped (EMAIL binding or ORDER_NOTIFY_TO not set):', subject);
    return;
  }
  const text = lines.join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13241b">${lines
    .map((l) => (l === '' ? '<br>' : `<div>${esc(l)}</div>`))
    .join('')}${extra.button ? `<p style="margin-top:20px"><a href="${esc(extra.button.href)}" style="background:#229b5e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:bold;display:inline-block">${esc(extra.button.label)}</a></p>` : ''}</div>`;
  try {
    await sendEmail(env, {
      to: ownerEmail(env),
      from: { email: extra.from || env.ORDER_EMAIL_FROM || `orders@${domainOf(env)}`, name: extra.fromName || 'Vitality Chews Store' },
      ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
      subject,
      text: extra.button ? `${text}\n\n${extra.button.label}: ${extra.button.href}` : text,
      html,
    });
  } catch (e) {
    console.error('owner email failed:', subject, e.message);
  }
}

// Tell the owner a customer wrote in. Reply-To is the signed reply+ address, so a reply from the owner's inbox
// comes back to the Worker, not to the customer.
async function notifyNewMessage(env, thread, msg, attachmentCount) {
  const includeBody = env.INBOX_NOTIFY_BODY !== 'false';
  const who = thread.customer_name ? `${thread.customer_name} <${thread.customer_email}>` : thread.customer_email;
  const lines = [
    ...(includeBody ? [MARKER, ''] : []),
    `${who} wrote${msg.sent_via === 'contact-form' ? ' through the contact form' : ` to ${thread.mailbox}`}.`,
    `Subject: ${thread.subject || '(no subject)'}`,
    '',
  ];
  if (includeBody) {
    const body = msg.body_text.length > 8000 ? msg.body_text.slice(0, 8000) + '\n[...] Open the admin to read the rest.' : msg.body_text;
    lines.push(...body.split('\n'), '');
    if (attachmentCount) lines.push(`${attachmentCount} attachment${attachmentCount > 1 ? 's' : ''}: open the admin to view.`, '');
    lines.push('Reply to this email and only the text you type is sent to the customer from ' + supportEmail(env) + '. Your own address is never shared.');
  } else {
    lines.push('Open the admin to read and answer it.');
  }
  await notifyOwner(env, `New message from ${thread.customer_name || thread.customer_email}: ${thread.subject || '(no subject)'}`, lines, {
    from: `inbox@${domainOf(env)}`,
    fromName: 'Vitality Chews Inbox',
    replyTo: await ownerReplyAddress(env, thread.id),
    button: { label: 'Open in admin', href: `${adminBase(env)}/admin/thread/${thread.id}` },
  });
}

// Send a reply to the customer on a thread, from hello@, threaded with the conversation.
export async function sendToCustomer(env, threadId, body, via) {
  const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId).first();
  if (!thread) throw new Error('Conversation not found');
  const clean = String(body || '').trim();
  if (!clean) throw new Error('The reply is empty');
  const subjectBase = thread.subject || 'Your message to Vitality Chews';
  const subject = /^re:/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`;
  const { results: prior } = await env.DB.prepare(
    "SELECT message_id FROM messages WHERE thread_id = ? AND message_id IS NOT NULL AND message_id LIKE '<%>' ORDER BY id DESC LIMIT 10"
  ).bind(threadId).all();
  const lastIn = await env.DB.prepare("SELECT message_id FROM messages WHERE thread_id = ? AND direction = 'in' AND message_id LIKE '<%>' ORDER BY id DESC LIMIT 1").bind(threadId).first();
  const headers = {};
  if (lastIn?.message_id) headers['In-Reply-To'] = lastIn.message_id;
  if (prior.length) headers.References = prior.map((p) => p.message_id).reverse().join(' ');

  const signature = `\n\nVitality Chews\n${supportEmail(env)}\n${env.SITE_URL || ''}`;
  const res = await sendEmail(env, {
    to: thread.customer_name ? { email: thread.customer_email, name: thread.customer_name } : thread.customer_email,
    from: { email: supportEmail(env), name: 'Vitality Chews' },
    replyTo: await customerReplyAddress(env, threadId),
    subject,
    text: clean + signature,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#13241b">${esc(clean).replace(/\n/g, '<br>')}<br><br>Vitality Chews<br><a href="mailto:${esc(supportEmail(env))}">${esc(supportEmail(env))}</a></div>`,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (thread_id, direction, from_email, from_name, to_email, subject, body_text, message_id, in_reply_to, sent_via, created_at) VALUES (?, 'out', ?, 'Vitality Chews', ?, ?, ?, ?, ?, ?, ?)"
    ).bind(threadId, supportEmail(env), thread.customer_email, subject, clean, normId(res?.messageId), headers['In-Reply-To'] || null, via, now),
    env.DB.prepare('UPDATE threads SET last_message_at = ?, unread = 0 WHERE id = ?').bind(now, threadId),
  ]);
  return res;
}

// Start a new conversation (admin "New email")
export async function startThread(env, { to, name = '', subject, body }) {
  const now = nowIso();
  const r = await env.DB.prepare(
    "INSERT INTO threads (customer_email, customer_name, subject, mailbox, source, status, unread, last_message_at, created_at) VALUES (?, ?, ?, ?, 'admin', 'open', 0, ?, ?)"
  ).bind(to.toLowerCase(), name, subject, supportEmail(env), now, now).run();
  const id = r.meta.last_row_id;
  await sendToCustomer(env, id, body, 'admin');
  // first message should not carry "Re:"
  await env.DB.prepare("UPDATE messages SET subject = ? WHERE thread_id = ? AND direction = 'out'").bind(subject, id).run();
  return id;
}

// ---------- storing inbound messages ----------
async function findThread(env, tagThreadId, refs, customerEmail) {
  if (tagThreadId) {
    const t = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(tagThreadId).first();
    if (t) return t;
  }
  const ids = refs.filter(Boolean).slice(-20);
  if (ids.length) {
    const row = await env.DB.prepare(`SELECT thread_id FROM messages WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).bind(...ids).first();
    if (row) {
      const t = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(row.thread_id).first();
      if (t && t.customer_email === customerEmail) return t;
    }
  }
  return null;
}

export async function storeInbound(env, { customerEmail, customerName, subject, mailbox, source, body, messageId, inReplyTo, refs = [], tagThreadId = null, auto = false, attachments = [] }) {
  const now = nowIso();
  let thread = await findThread(env, tagThreadId, [inReplyTo, ...refs], customerEmail);
  if (!thread) {
    const r = await env.DB.prepare(
      'INSERT INTO threads (customer_email, customer_name, subject, mailbox, source, status, unread, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, \'open\', 1, ?, ?)'
    ).bind(customerEmail, customerName || '', subject || '', mailbox, source, now, now).run();
    thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(r.meta.last_row_id).first();
  } else {
    await env.DB.prepare("UPDATE threads SET status = 'open', unread = 1, last_message_at = ?, customer_name = CASE WHEN customer_name = '' THEN ? ELSE customer_name END WHERE id = ?")
      .bind(now, customerName || '', thread.id).run();
  }
  const msg = {
    sent_via: source === 'contact-form' ? 'contact-form' : 'inbound',
    body_text: (body || '').slice(0, MAX_BODY),
  };
  const ins = await env.DB.prepare(
    "INSERT INTO messages (thread_id, direction, from_email, from_name, to_email, subject, body_text, message_id, in_reply_to, sent_via, auto, created_at) VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(thread.id, customerEmail, customerName || '', mailbox, subject || '', msg.body_text, normId(messageId), normId(inReplyTo), msg.sent_via, auto ? 1 : 0, now).run();
  const messageRowId = ins.meta.last_row_id;

  let saved = 0;
  for (const a of attachments) {
    const content = a.content;
    const size = content?.byteLength || 0;
    if (!size || size > MAX_ATTACHMENT || !env.MAIL_FILES) continue;
    const key = `threads/${thread.id}/${messageRowId}/${randomToken(8)}`;
    await env.MAIL_FILES.put(key, content, { httpMetadata: { contentType: a.mimeType || 'application/octet-stream' } });
    await env.DB.prepare('INSERT INTO attachments (message_id, filename, content_type, size, r2_key) VALUES (?, ?, ?, ?, ?)')
      .bind(messageRowId, (a.filename || 'attachment').slice(0, 200), a.mimeType || 'application/octet-stream', size, key).run();
    saved++;
  }
  if (!auto) await notifyNewMessage(env, thread, msg, saved);
  return thread.id;
}

// ---------- email() handler ----------
export async function handleEmail(message, env) {
  const to = (message.to || '').toLowerCase();
  const [local = '', dom = ''] = to.split('@');
  const [base, tag] = local.split('+');
  const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const text = (parsed.text && parsed.text.trim()) || htmlToText(parsed.html || '');

  // 1) The owner answering a notification by email
  if (base === 'reply') {
    const threadId = await readTag(env, 'owner', tag);
    const sender = (parsed.from?.address || message.from || '').toLowerCase();
    const owner = ownerEmail(env);
    if (!threadId || !owner || sender !== owner || !ownerAuthPassed(message.headers, owner.split('@')[1])) {
      console.warn('rejected reply+ message', { to, sender, threadId });
      message.setReject('Address not accepted');
      return;
    }
    const body = stripReply(text);
    if (!body) {
      await notifyOwner(env, 'Your reply was empty, so nothing was sent', ['We could not find any new text above the quoted message, so nothing went to the customer.'], {
        from: `inbox@${domainOf(env)}`, fromName: 'Vitality Chews Inbox',
        button: { label: 'Open in admin', href: `${adminBase(env)}/admin/thread/${threadId}` },
      });
      return;
    }
    try {
      await sendToCustomer(env, threadId, body, 'email-reply');
    } catch (e) {
      console.error('email reply failed', e.message);
      await notifyOwner(env, 'Your reply was NOT sent', [`Sending your reply to the customer failed: ${e.message}`, '', 'Open the admin and send it from there.'], {
        from: `inbox@${domainOf(env)}`, fromName: 'Vitality Chews Inbox',
        button: { label: 'Open in admin', href: `${adminBase(env)}/admin/thread/${threadId}` },
      });
    }
    return;
  }

  // 2) Our own notification addresses never receive mail
  if (['inbox', 'orders'].includes(base) && dom === domainOf(env)) {
    message.setReject('This address does not accept mail. Write to ' + supportEmail(env));
    return;
  }

  // 3) A customer (or anyone) writing to any other address on the domain
  const customerEmail = (parsed.replyTo?.[0]?.address || parsed.from?.address || message.from || '').toLowerCase();
  const customerName = parsed.replyTo?.[0]?.name || parsed.from?.name || '';
  const tagThreadId = tag ? await readTag(env, 'customer', tag) : null;
  const refs = String(parsed.references || '').split(/\s+/).map(normId).filter(Boolean);
  await storeInbound(env, {
    customerEmail,
    customerName,
    subject: parsed.subject || '',
    mailbox: `${base}@${dom}`,
    source: 'email',
    body: text,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    refs,
    tagThreadId,
    auto: isAutomated(message.headers, message.from),
    attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, mimeType: a.mimeType, content: a.content })),
  });
}

// ---------- contact form ----------
export async function handleContact(request, env) {
  const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });
  let f;
  try { f = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  if (f.website) return json({ ok: true }); // honeypot: pretend success
  const name = String(f.name || '').trim().slice(0, 120);
  const email = String(f.email || '').trim().toLowerCase().slice(0, 200);
  const order = String(f.order || '').trim().slice(0, 40);
  const message = String(f.message || '').trim().slice(0, 5000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: 'Please enter a valid email address.' }, 400);
  if (message.length < 5) return json({ error: 'Please write a short message.' }, 400);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if ((await rateLimited(env, `contact:${ip}`, 5, 60)) || (await rateLimited(env, 'contact:all', 60, 60))) {
    return json({ error: `Too many messages right now. Please email ${supportEmail(env)} instead.` }, 429);
  }
  const subject = order ? `Contact form: order ${order}` : 'Contact form message';
  await storeInbound(env, {
    customerEmail: email,
    customerName: name,
    subject,
    mailbox: supportEmail(env),
    source: 'contact-form',
    body: (order ? `Order number: ${order}\n\n` : '') + message,
  });
  return json({ ok: true });
}
