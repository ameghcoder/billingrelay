"use client";

import { publicCheckoutSchema, type PublicCheckout } from "@billingrelay/core/checkouts";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const CONFIRM_ATTEMPTS = 8;
const CONFIRM_GAP_MS = 4_000;

const DONT_PAY_AGAIN = "Please don't pay again. Nothing more will be charged.";

const MESSAGES = {
  captured: { title: "Payment received", body: "Thank you. You can go back now." },
  failed: { title: "The payment didn't go through", body: "Nothing was charged. Go back to try again." },
  expired: { title: "This checkout has expired", body: "Nothing was charged. Go back to start again." },
  unresolved: { title: "We couldn't confirm your payment yet", body: `${DONT_PAY_AGAIN} If this stays, contact the seller.` },
  refund_review: { title: "This payment is being reviewed", body: "Contact the seller if you have questions." },
  approved: { title: "PayPal is still processing this", body: DONT_PAY_AGAIN },
};

// No attempt got an answer, so what we last knew may be out of date, and money may have moved since.
const NO_ANSWER = { title: "We couldn't confirm your payment yet", body: `${DONT_PAY_AGAIN} Reload this page to check again.` };

type Item = { name: string; variantName: string | null; quantity: number; total: string; monthly: boolean };

type Props = { id: string; item: Item; initial: PublicCheckout; hasOrder: boolean; returning: boolean; cancelled: boolean };

async function post(path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const response = await fetch(path, { method: "POST" });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

const readState = (body: unknown) => publicCheckoutSchema.safeParse(body).data ?? null;

export function CheckoutPanel({ id, item, initial, hasOrder, returning, cancelled }: Props) {
  const [state, setState] = useState(initial);
  const [confirming, setConfirming] = useState(hasOrder && !initial.settled);
  const [noAnswer, setNoAnswer] = useState(false);
  const [paying, setPaying] = useState(false);
  // On a slow connection the button shows before its click works. A click then would silently do nothing.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repeating is safe, because the server captures an order only once. The redirect back isn't proof, so the server decides.
  const confirm = useCallback(async () => {
    setConfirming(true);
    let answered = false;
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CONFIRM_GAP_MS));
      const { status, body } = await post(`/checkout/${id}/confirm`);
      const current = readState(body);
      if (current) setState(current);
      answered = status === 200 && current !== null;
      if (answered && current?.money !== "approved") break;
    }
    setNoAnswer(!answered);
    setConfirming(false);
  }, [id]);

  useEffect(() => setReady(true), []);

  // Coming back from PayPal with the browser's Back button can restore this page exactly as it was left: still "Opening PayPal…".
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPaying(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  useEffect(() => {
    if (!hasOrder || initial.settled) return;
    void confirm();
  }, [confirm, hasOrder, initial.settled]);

  async function pay() {
    setPaying(true);
    setError(null);
    const { body } = await post(`/checkout/${id}/pay`);
    if (typeof body?.approvalUrl === "string") {
      window.location.assign(body.approvalUrl);
      return;
    }
    setPaying(false);
    const current = readState(body);
    if (current) setState(current);
    else setError("PayPal can't be reached right now. Nothing was charged. Try again shortly.");
  }

  const pendingMessage = noAnswer ? NO_ANSWER : null;
  const message = state.money === "pending" ? pendingMessage : MESSAGES[state.money];

  return (
    <Card data-testid="checkout" data-money={state.money} data-confirming={confirming}>
      <CardHeader>
        <CardTitle>{item.name}</CardTitle>
        {item.variantName && <CardDescription>{item.variantName}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Quantity</dt>
            <dd>{item.quantity}</dd>
          </div>
          <div className="flex justify-between text-base font-semibold">
            <dt>{item.monthly ? "Every month" : "Total"}</dt>
            <dd data-testid="checkout-total">{item.total}</dd>
          </div>
        </dl>

        {confirming && state.money !== "captured" ? (
          <div role="status" className="text-sm">
            <p className="font-medium">Confirming your payment…</p>
            <p className="text-muted-foreground">{DONT_PAY_AGAIN}</p>
          </div>
        ) : message ? (
          <div role="status" className="text-sm">
            <p className="font-medium">{message.title}</p>
            <p className="text-muted-foreground">{message.body}</p>
          </div>
        ) : (
          <>
            {cancelled && <p className="text-sm text-muted-foreground">You cancelled at PayPal. Nothing was charged.</p>}
            {returning && !cancelled && <p className="text-sm text-muted-foreground">PayPal hasn&apos;t confirmed an approval yet. Nothing was charged.</p>}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button data-testid="pay" disabled={paying || !ready} onClick={pay}>
              {paying ? "Opening PayPal…" : item.monthly ? "Subscribe with PayPal" : "Pay with PayPal"}
            </Button>
          </>
        )}

        {!confirming && (
          <Button variant="outline" asChild>
            <a href={state.backUrl}>Back to the seller</a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
