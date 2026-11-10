-- Each customer's credit balance, copied as BillingRelay computed it. Adds only. Monthly credits stop counting at monthly_ends_at
-- even before the next copy arrives: SELECT CASE WHEN monthly_ends_at > now() THEN monthly ELSE 0 END + packs.
BEGIN;

CREATE TABLE billingrelay.credit_balances (
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  environment text NOT NULL,
  customer_id uuid NOT NULL,
  external_customer_id text NOT NULL,
  monthly bigint NOT NULL,
  packs bigint NOT NULL,
  total bigint NOT NULL,
  monthly_ends_at timestamptz,
  source_version integer NOT NULL,
  source_updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, account_id),
  FOREIGN KEY (project_id, customer_id) REFERENCES billingrelay.customers (project_id, customer_id)
);
CREATE INDEX credit_balances_customer_idx ON billingrelay.credit_balances (project_id, external_customer_id);

GRANT SELECT, INSERT, UPDATE ON billingrelay.credit_balances TO billingrelay_sync;

INSERT INTO billingrelay.schema_version (version) VALUES (3);

COMMIT;
