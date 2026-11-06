-- Orders placed through Stripe Checkout, exported to ShipStation for Rocktomic fulfillment
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent TEXT,
  status TEXT NOT NULL DEFAULT 'paid',          -- paid | shipped | cancelled
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  ship_name TEXT NOT NULL DEFAULT '',
  ship_line1 TEXT NOT NULL DEFAULT '',
  ship_line2 TEXT NOT NULL DEFAULT '',
  ship_city TEXT NOT NULL DEFAULT '',
  ship_state TEXT NOT NULL DEFAULT '',
  ship_postal TEXT NOT NULL DEFAULT '',
  ship_country TEXT NOT NULL DEFAULT 'US',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  carrier TEXT,
  tracking_number TEXT,
  shipped_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_updated ON orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_pi ON orders(stripe_payment_intent);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  weight_oz REAL NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
