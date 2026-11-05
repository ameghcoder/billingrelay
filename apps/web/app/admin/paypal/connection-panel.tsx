"use client";

import {
  savePaypalConnectionSchema,
  type PaypalCheckResult,
  type PaypalConnectionView,
  type PaypalWebhookError,
  type SavePaypalConnection,
} from "@billingrelay/core/paypal-connection";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CONNECTION_URL = "/admin/paypal/connections/sandbox";

const CHECK_LABELS: Record<PaypalCheckResult, string> = {
  ok: "Healthy",
  credentials_rejected: "PayPal rejected the saved credentials. Enter them again.",
  paypal_unreachable: "Couldn't reach PayPal. Try again.",
  secret_unreadable: "Secret unreadable. Enter it again.",
  webhook_missing: "Webhook missing or changed",
  capability_missing: "This PayPal app is missing a capability",
};

const WEBHOOK_ERROR_LABELS: Record<PaypalWebhookError, string> = {
  public_url_invalid: "PUBLIC_BASE_URL must be an https URL",
  webhook_rejected: "PayPal rejected the webhook",
  paypal_unreachable: "Couldn't reach PayPal",
  webhook_missing: "Not found at PayPal",
};

const CAPABILITY_LABELS = { checkout: "One-time checkout", subscriptions: "Subscriptions", webhooks: "Webhooks" };

async function callConnection(path: string, init: RequestInit): Promise<PaypalConnectionView> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? "Something went wrong. Try again shortly.");
  return body;
}

export function ConnectionPanel({ initial }: { initial: PaypalConnectionView | null }) {
  const [connection, setConnection] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<SavePaypalConnection>({
    resolver: zodResolver(savePaypalConnectionSchema),
    defaultValues: { clientId: "", clientSecret: "" },
  });

  async function run(request: () => Promise<PaypalConnectionView>) {
    setBusy(true);
    setError(null);
    try {
      setConnection(await request());
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong. Try again shortly.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const save = form.handleSubmit(async (values) => {
    const saved = await run(() =>
      callConnection(CONNECTION_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      }),
    );
    if (saved) form.reset();
  });

  return (
    <div className="mt-6 grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{connection ? "Replace credentials" : "Connect PayPal"}</CardTitle>
          <CardDescription>From your sandbox REST app in the PayPal developer dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="clientId">Client ID</Label>
              <Input id="clientId" autoComplete="off" spellCheck={false} {...form.register("clientId")} />
              {form.formState.errors.clientId && (
                <p className="text-sm text-destructive">{form.formState.errors.clientId.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="clientSecret">Secret</Label>
              <Input id="clientSecret" type="password" autoComplete="new-password" {...form.register("clientSecret")} />
              {form.formState.errors.clientSecret && (
                <p className="text-sm text-destructive">{form.formState.errors.clientSecret.message}</p>
              )}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Working…" : "Save and check"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {connection && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Status
              <Badge variant={connection.lastCheck === "ok" ? "default" : "destructive"}>
                {connection.lastCheck === "ok" ? "Healthy" : "Needs attention"}
              </Badge>
            </CardTitle>
            {connection.lastCheck && connection.lastCheck !== "ok" && (
              <CardDescription>{CHECK_LABELS[connection.lastCheck]}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">Client ID</dt>
              <dd>{connection.clientId}</dd>
              <dt className="text-muted-foreground">Secret</dt>
              <dd>Stored encrypted</dd>
              <dt className="text-muted-foreground">Webhook</dt>
              <dd>
                {connection.webhook.status === "registered"
                  ? "Set up"
                  : `Not set up${connection.webhook.error ? `: ${WEBHOOK_ERROR_LABELS[connection.webhook.error]}` : ""}`}
                {connection.webhook.url && (
                  <span className="block break-all text-muted-foreground">{connection.webhook.url}</span>
                )}
              </dd>
              {connection.capabilities &&
                (Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]).map((capability) => (
                  <div key={capability} className="contents">
                    <dt className="text-muted-foreground">{CAPABILITY_LABELS[capability]}</dt>
                    <dd>{connection.capabilities?.[capability] ? "Available" : "Missing"}</dd>
                  </div>
                ))}
              <dt className="text-muted-foreground">Last checked</dt>
              <dd>{connection.lastCheckedAt ? new Date(connection.lastCheckedAt).toLocaleString() : "Never"}</dd>
            </dl>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run(() => callConnection(`${CONNECTION_URL}/check`, { method: "POST" }))}
              >
                Check now
              </Button>
              {connection.webhook.status !== "registered" && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(() => callConnection(`${CONNECTION_URL}/webhook`, { method: "POST" }))}
                >
                  Retry webhook setup
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
