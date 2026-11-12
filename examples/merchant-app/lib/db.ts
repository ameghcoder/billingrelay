import pg from "pg";

// This app reads only its own database. BillingRelay keeps it up to date; nothing here asks BillingRelay what a user owns.
let pool: pg.Pool | undefined;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.MERCHANT_DATABASE_URL, max: 3 }));

export type Owned = {
  access: { access_key: string; active_until: Date | null }[];
  purchases: { checkout_id: string; product_name: string; amount: string; currency: string; money_status: string; created_at: Date }[];
  credits: { total: string; monthly: string; packs: string } | null;
};

export async function readOwned(externalCustomerId: string): Promise<Owned> {
  const [access, purchases, credits] = await Promise.all([
    db().query(
      `SELECT access_key, active_until FROM billingrelay.access
        WHERE external_customer_id = $1 AND status = 'active' AND (active_until IS NULL OR active_until > now()) ORDER BY access_key`,
      [externalCustomerId],
    ),
    db().query(
      `SELECT checkout_id, product_name, amount, currency, money_status, created_at FROM billingrelay.purchases
        WHERE external_customer_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [externalCustomerId],
    ),
    db().query("SELECT total, monthly, packs FROM billingrelay.credit_balances WHERE external_customer_id = $1", [externalCustomerId]),
  ]);
  return { access: access.rows, purchases: purchases.rows, credits: credits.rows[0] ?? null };
}

export async function hasPurchase(checkoutId: string): Promise<boolean> {
  return (await db().query("SELECT 1 FROM billingrelay.purchases WHERE checkout_id = $1", [checkoutId])).rowCount === 1;
}
