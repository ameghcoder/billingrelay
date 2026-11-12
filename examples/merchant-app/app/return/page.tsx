import { BillingRelayError } from "@billingrelay/sdk";
import Link from "next/link";
import { billing } from "@/lib/billing";
import { hasPurchase } from "@/lib/db";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// The buyer coming back proves nothing. Ask BillingRelay from this server, and show access only once this app's database has it.
export default async function Return({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const { checkout: id } = await searchParams;
  const user = await currentUser();
  if (!id || !user) return <Link href="/">Back to the shop</Link>;

  let status;
  try {
    status = await billing().checkouts.get(id);
  } catch (error) {
    return <p>Couldn&apos;t read this checkout: {error instanceof BillingRelayError ? error.code : "BillingRelay is unreachable"}. <Link href="/">Back</Link></p>;
  }
  if (status.externalCustomerId !== user) return <p>This checkout belongs to someone else. <Link href="/">Back</Link></p>;

  const inMyDatabase = await hasPurchase(id);
  const waiting = status.nextAction === "wait" || (status.money === "captured" && !inMyDatabase);
  return (
    <>
      {waiting && <meta httpEquiv="refresh" content="3" />}
      <h1>{status.snapshot.product.name}</h1>
      <table>
        <tbody>
          <tr><th>Money</th><td>{status.money}</td></tr>
          <tr><th>Fulfillment</th><td>{status.fulfillment}</td></tr>
          <tr><th>Copy to this app</th><td>{status.sync}</td></tr>
          <tr><th>In this app&apos;s database</th><td>{inMyDatabase ? "yes" : "not yet"}</td></tr>
        </tbody>
      </table>
      <p className="muted">{waiting ? "Checking again in 3 seconds…" : null}</p>
      <Link href="/">Back to the shop</Link>
    </>
  );
}
