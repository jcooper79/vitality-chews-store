-- Customer email inbox (Cloudflare Email Routing -> Worker) and the admin portal
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  mailbox TEXT NOT NULL DEFAULT '',            -- address the customer wrote to, e.g. hello@vitalitychews.com
  source TEXT NOT NULL DEFAULT 'email',        -- email | contact-form | admin
  status TEXT NOT NULL DEFAULT 'open',         -- open | closed
  unread INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_threads_customer ON threads(customer_email);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  direction TEXT NOT NULL,                     -- in | out
  from_email TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  to_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  message_id TEXT,                             -- RFC 5322 Message-ID (or send() id for outbound)
  in_reply_to TEXT,
  sent_via TEXT NOT NULL DEFAULT '',           -- inbound | admin | email-reply | contact-form
  auto INTEGER NOT NULL DEFAULT 0,             -- 1 for auto-replies / bulk mail
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS admin_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                          -- login (one-time sign-in link) | session
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket TEXT NOT NULL,                        -- e.g. login, contact:<ip>
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_bucket ON rate_events(bucket, created_at);
