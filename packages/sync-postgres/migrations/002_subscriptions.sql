-- Subscriptions, and when a subscription's access ends. Adds only. Read access as:
-- status = 'active' AND (active_until IS NULL OR active_until > now())
BEGIN;

ALTER TABLE billingrelay.access ADD COLUMN active_until timestamptz;

CREATE TABLE billingrelay.subscriptions (
  project_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  environment text NOT NULL,
  customer_id uuid NOT NULL,
  external_customer_id text NOT NULL,
  checkout_id uuid NOT NULL,
  product_ref text NOT NULL,
  status text NOT NULL,
  review_reason text,
  paid_through timestamptz,
  access_until timestamptz,
  cancel_requested boolean NOT NULL,
  paypal_subscription_id text NOT NULL,
  source_version integer NOT NULL,
  source_updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, subscription_id),
  FOREIGN KEY (project_id, customer_id) REFERENCES billingrelay.customers (project_id, customer_id)
);
CREATE INDEX subscriptions_customer_idx ON billingrelay.subscriptions (project_id, external_customer_id, product_ref);

GRANT SELECT, INSERT, UPDATE ON billingrelay.subscriptions TO billingrelay_sync;

INSERT INTO billingrelay.schema_version (version) VALUES (2);

COMMIT;
