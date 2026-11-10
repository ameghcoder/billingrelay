"use client";

import type { CustomerTraceView, TraceStepView } from "@billingrelay/core/dashboard";
import { formatPrice } from "@billingrelay/core/catalog";
import type { ColDef } from "ag-grid-community";
import { DataGrid } from "@/components/data-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTime } from "../../billing/list-controls";

type StepRow = { id: string; at: string; step: string; detail: string; status: string; code: string; duration: string };

const record = (step: { entityType: string; sourceVersion: number }) => `${step.entityType} v${step.sourceVersion}`;
const attempts = (count: number) => `${count} ${count === 1 ? "attempt" : "attempts"}`;

function toRow(step: TraceStepView, index: number): StepRow {
  const base = { id: String(index), at: step.at, detail: "", status: "", code: "", duration: "" };
  switch (step.kind) {
    case "checkout_created":
      return { ...base, step: "Checkout created" };
    case "capture_requested":
      return { ...base, step: "Capture sent to PayPal" };
    case "event":
      return { ...base, step: "PayPal event", detail: `${step.eventType}, ${attempts(step.attempts)}`, status: step.status, code: step.failureCode ?? "" };
    case "effect":
      return { ...base, step: "Billing effect", detail: `${step.effect} for payment ${step.paypalPaymentId}` };
    case "grant":
      return { ...base, step: "Access grant", detail: step.accessKey, status: step.status };
    case "outbox":
      return {
        ...base,
        step: "Queued for sync",
        detail: `${record(step)}, ${attempts(step.attempts)}`,
        status: step.status,
        code: step.failureCode ?? "",
      };
    case "sync_attempt":
      return {
        ...base,
        step: "Sync attempt",
        detail: record(step),
        status: step.outcome,
        code: step.code ?? "",
        duration: step.durationMs === null ? "" : `${step.durationMs} ms`,
      };
  }
}

const columns: ColDef<StepRow>[] = [
  { field: "at", headerName: "When", minWidth: 170, flex: 2, valueFormatter: ({ value }) => formatTime(value) },
  { field: "step", headerName: "Step", minWidth: 150, flex: 2 },
  { field: "detail", headerName: "Detail", minWidth: 200, flex: 3 },
  { field: "status", headerName: "Status", minWidth: 100, flex: 1 },
  { field: "code", headerName: "Code", minWidth: 130, flex: 2 },
  { field: "duration", headerName: "Duration", minWidth: 90, flex: 1 },
];

export function TraceView({ trace }: { trace: CustomerTraceView }) {
  if (trace.checkouts.length === 0) return <p className="text-muted-foreground">No checkouts yet.</p>;
  return (
    <div className="flex flex-col gap-6">
      {trace.checkouts.map((checkout) => (
        <Card key={checkout.id} data-testid="trace-checkout">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {checkout.productRef} · {formatPrice(checkout.amount, checkout.currency)} {checkout.currency}
              <Badge variant="secondary">money: {checkout.money}</Badge>
              <Badge variant="secondary">fulfillment: {checkout.fulfillment}</Badge>
              <Badge variant={checkout.sync === "failed" ? "destructive" : "secondary"}>sync: {checkout.sync}</Badge>
            </CardTitle>
            <CardDescription className="break-all">
              Checkout {checkout.id}
              {checkout.moneyReason ? ` · reason ${checkout.moneyReason}` : ""} · PayPal order {checkout.paypalOrderId ?? "none"} · capture{" "}
              {checkout.paypalCaptureId ?? "none"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataGrid label={`Trace of checkout ${checkout.id}`} rows={checkout.steps.map(toRow)} columns={columns} rowId={(row) => row.id} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
