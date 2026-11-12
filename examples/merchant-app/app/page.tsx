import { randomUUID } from "node:crypto";
import { products } from "@/lib/billing";
import { readOwned } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { buy, signIn, signOut, spendCredits } from "./actions";

export const dynamic = "force-dynamic";

const money = (amount: string, currency: string) => `${(Number(amount) / 100).toFixed(2)} ${currency}`;

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string; note?: string }> }) {
  const { error, note } = await searchParams;
  const user = await currentUser();
  if (!user) {
    return (
      <>
        <h1>Example shop</h1>
        <p className="muted">Sign in as any user ID. This stands in for your real login.</p>
        <form action={signIn}>
          <input name="user" placeholder="user_123" required pattern="[\w.\-]{1,64}" /> <button>Sign in</button>
        </form>
      </>
    );
  }

  const owned = await readOwned(user);
  return (
    <>
      <h1>Example shop</h1>
      <div>
        Signed in as <b>{user}</b>{" "}
        <form action={signOut}>
          <button>Sign out</button>
        </form>
      </div>
      {(error || note) && <p className="note">{error ? `BillingRelay refused: ${error}` : note}</p>}

      <section>
        <h2>Buy</h2>
        {products().map(({ productRef, variantRef }) => (
          <form key={`${productRef}:${variantRef ?? ""}`} action={buy}>
            <input type="hidden" name="productRef" value={productRef} />
            <input type="hidden" name="variantRef" value={variantRef ?? ""} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <button>Buy {variantRef ? `${productRef} (${variantRef})` : productRef}</button>
          </form>
        ))}
      </section>

      <section>
        <h2>What you have (read from this app&apos;s own database)</h2>
        {owned.access.length === 0 ? (
          <p className="muted">No access yet.</p>
        ) : (
          <ul>
            {owned.access.map((row) => (
              <li key={row.access_key}>
                {row.access_key}
                {row.active_until && <span className="muted"> until {row.active_until.toISOString().slice(0, 16).replace("T", " ")} UTC</span>}
              </li>
            ))}
          </ul>
        )}
        <div>
          Credits: <b>{owned.credits?.total ?? 0}</b>
          {owned.credits && <span className="muted"> ({owned.credits.monthly} monthly, {owned.credits.packs} from packs)</span>}{" "}
          <form action={spendCredits}>
            <button>Use 10 credits</button>
          </form>
        </div>
      </section>

      {owned.purchases.length > 0 && (
        <section>
          <h2>Purchases</h2>
          <table>
            <tbody>
              {owned.purchases.map((row) => (
                <tr key={row.checkout_id}>
                  <td>{row.product_name}</td>
                  <td>{money(row.amount, row.currency)}</td>
                  <td>{row.money_status}</td>
                  <td className="muted">{row.created_at.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
