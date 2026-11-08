-- BillingRelay destination tables, version 1. Run by the database's owner, once.
-- `pnpm destination:setup` runs this for you and refuses an existing `billingrelay` schema it didn't make.
-- To paste it into an SQL editor instead (Supabase, for example), first check that no `billingrelay` schema exists.
-- BillingRelay writes these tables; your app only reads them. Nothing here touches your own tables.

BEGIN;

CREATE SCHEMA billingrelay;

CREATE TABLE billingrelay.schema_version (
  version integer PRIMARY KEY CHECK (version > 0),
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Your app's user ID is `external_customer_id`. Written once, never changed.
CREATE TABLE billingrelay.customers (
  project_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  external_customer_id text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, customer_id),
  UNIQUE (project_id, external_customer_id)
);

-- One row per checkout, from its first payment change. Decide access from `access`, not from here.
CREATE TABLE billingrelay.purchases (
  project_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  environment text NOT NULL,
  customer_id uuid NOT NULL,
  external_customer_id text NOT NULL,
  product_ref text NOT NULL,
  product_name text NOT NULL,
  product_kind text NOT NULL,
  variant_ref text,
  quantity integer NOT NULL,
  amount bigint NOT NULL,
  currency text NOT NULL,
  money_status text NOT NULL,
  fulfillment_status text NOT NULL,
  paypal_capture_id text,
  metadata jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  source_version integer NOT NULL,
  source_updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, checkout_id),
  FOREIGN KEY (project_id, customer_id) REFERENCES billingrelay.customers (project_id, customer_id)
);
CREATE INDEX purchases_customer_idx ON billingrelay.purchases (project_id, external_customer_id);

-- One row per paid purchase that grants access. A refund makes it `restricted`; nothing is ever deleted.
CREATE TABLE billingrelay.access (
  project_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  environment text NOT NULL,
  customer_id uuid NOT NULL,
  external_customer_id text NOT NULL,
  access_key text NOT NULL,
  checkout_id uuid NOT NULL,
  status text NOT NULL,
  source_version integer NOT NULL,
  source_updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, grant_id),
  FOREIGN KEY (project_id, customer_id) REFERENCES billingrelay.customers (project_id, customer_id)
);
CREATE INDEX access_customer_idx ON billingrelay.access (project_id, external_customer_id, access_key);

-- The role BillingRelay's worker logs in as. It can read and write these tables, and nothing else:
-- no DELETE, and no CREATE or DROP anywhere. Give it a password and LOGIN separately (see the setup docs).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'billingrelay_sync') THEN
    CREATE ROLE billingrelay_sync NOLOGIN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO billingrelay_sync', current_database());
END $$;

GRANT USAGE ON SCHEMA billingrelay TO billingrelay_sync;
GRANT SELECT ON billingrelay.schema_version TO billingrelay_sync;
GRANT SELECT, INSERT, UPDATE ON billingrelay.customers, billingrelay.purchases, billingrelay.access TO billingrelay_sync;

INSERT INTO billingrelay.schema_version (version) VALUES (1);

COMMIT;
