import { formatPrice } from "@billingrelay/core/catalog";
import { findCheckout } from "@billingrelay/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/api-response";
import { toPublicCheckout } from "@/lib/checkout";
import { clientIp, limiter, RATE_RULES } from "@/lib/rate-limit";
import { CheckoutPanel } from "./checkout-panel";

export const checkoutMetadata: Metadata = { title: "Checkout", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** Only what a buyer needs to see goes to the browser, so no customer ID or metadata reaches the page's data. */
export async function HostedCheckout({ id, returning, cancelled }: { id: string; returning: boolean; cancelled: boolean }) {
  // A page can't answer 429, so it says so instead, before reading the database.
  if (!limiter.hit(RATE_RULES.checkoutPage, clientIp(await headers())).allowed) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-8">
        <p data-testid="rate-limited" className="text-center text-sm text-muted-foreground">
          Too many requests. Wait a minute, then reload this page.
        </p>
      </main>
    );
  }
  const checkout = isUuid(id) ? await findCheckout(id) : null;
  if (!checkout || checkout.environment !== "sandbox") notFound();

  const { snapshot } = checkout;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-8">
      <CheckoutPanel
        id={checkout.id}
        item={{
          name: snapshot.product.name,
          variantName: snapshot.variant?.name ?? null,
          quantity: snapshot.quantity,
          total: formatPrice(snapshot.amount, snapshot.currency),
        }}
        initial={toPublicCheckout(checkout)}
        hasOrder={checkout.paypalOrderId !== null}
        returning={returning}
        cancelled={cancelled}
      />
    </main>
  );
}
