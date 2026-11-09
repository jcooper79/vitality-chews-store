-- Orders are copied to WooCommerce so Rocktomic's ShipStation (connected to WooCommerce) can fulfill them
ALTER TABLE orders ADD COLUMN wc_order_id INTEGER;
ALTER TABLE orders ADD COLUMN wc_order_number TEXT;
ALTER TABLE orders ADD COLUMN wc_sync_error TEXT;
ALTER TABLE orders ADD COLUMN wc_synced_at TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_wc ON orders(wc_order_id);
