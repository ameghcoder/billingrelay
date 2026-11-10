"use client";

import { useState } from "react";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { Button } from "@/components/ui/button";

type Action = { path: string; label: string; done: (body: Record<string, unknown>) => string };

const ACTIONS: Action[] = [
  { path: "/admin/sync/retry", label: "Retry now", done: (body) => `Retrying now; ${body.requeued} failed deliveries back in line.` },
  { path: "/admin/reconcile", label: "Scan now", done: (body) => `Scanning: ${body.unconfirmedOrders} unconfirmed orders, ${body.benefitsPending} awaiting benefits, ${body.failedEvents} failed events, ${body.failedDeliveries} failed deliveries.` },
  { path: "/admin/sync/resend", label: "Resend everything", done: (body) => `${body.requeued} records go to your database again; it keeps only newer versions.` },
];

/** The same handlers an approved AI repair runs, by hand. None of them can charge or change a balance. */
export function SyncActions() {
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: Action) {
    setBusy(true);
    setFailure(null);
    const result = await callAdminApi<Record<string, unknown>>(action.path, { method: "POST" });
    if ("failure" in result) setFailure(result.failure);
    else {
      setMessage(`${action.done(result.body)} Reload to see the lists change.`);
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((action) => (
          <Button key={action.path} size="sm" variant="outline" disabled={busy} onClick={() => run(action)} data-testid={`sync-${action.path.split("/").pop()}`}>
            {action.label}
          </Button>
        ))}
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {failure && <ApiFailureMessage failure={failure} />}
    </div>
  );
}
