"use server";

import { randomUUID } from "node:crypto";
import { BillingRelayError } from "@billingrelay/sdk";
import { redirect } from "next/navigation";
import { appUrl, billing } from "@/lib/billing";
import { currentUser, setUser } from "@/lib/session";

export async function signIn(form: FormData) {
  const id = String(form.get("user") ?? "").trim();
  if (/^[\w.-]{1,64}$/.test(id)) await setUser(id);
  redirect("/");
}

export async function signOut() {
  await setUser(null);
  redirect("/");
}

export async function buy(form: FormData) {
  const user = await currentUser();
  if (!user) redirect("/");
  const variantRef = String(form.get("variantRef") ?? "") || undefined;
  let checkoutUrl: string;
  try {
    // The key comes from the rendered page, so a double click returns the same checkout instead of a second one.
    const checkout = await billing().checkouts.create(
      { externalCustomerId: user, productRef: String(form.get("productRef")), variantRef, returnUrl: `${appUrl()}/return` },
      { idempotencyKey: String(form.get("idempotencyKey")) },
    );
    checkoutUrl = checkout.checkoutUrl;
  } catch (error) {
    redirect(`/?error=${encodeURIComponent(error instanceof BillingRelayError ? error.code : "billingrelay_unreachable")}`);
  }
  redirect(checkoutUrl);
}

export async function spendCredits() {
  const user = await currentUser();
  if (!user) redirect("/");
  let note: string;
  try {
    // Debit first, then do the work; on failure, `credits.compensate(usageId)` gives it back.
    const result = await billing().credits.consume({ externalCustomerId: user, amount: 10, usageId: randomUUID() });
    note = `used_${result.debited}`;
  } catch (error) {
    note = error instanceof BillingRelayError ? error.code : "billingrelay_unreachable";
  }
  redirect(`/?note=${encodeURIComponent(note)}`);
}
