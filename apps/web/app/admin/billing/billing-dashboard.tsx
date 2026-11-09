"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckoutsTab, type CheckoutFilterValues } from "./checkouts-tab";
import { EventsTab, type EventFilterValues } from "./events-tab";
import { formatTime } from "./list-controls";
import type { AttentionResponse } from "@billingrelay/core/dashboard";
import { SyncTab, type DeliveryFilterValues } from "./sync-tab";

type Tab = "checkouts" | "events" | "sync";
type View = { tab: Tab; checkouts: CheckoutFilterValues; events: EventFilterValues; deliveries: DeliveryFilterValues; version: number };

function AttentionItem({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b py-2 last:border-b-0">
      <span>{children}</span>
      {action}
    </li>
  );
}

/** Warnings only. None of them blocks a checkout: a buyer's return still captures without a webhook. */
function NeedsAttention({ attention, show }: { attention: AttentionResponse; show: (view: Partial<View> & { tab: Tab }) => void }) {
  const { failedEvents, unclearCheckouts, failedDeliveries, destination, webhook } = attention;
  const destinationProblem = destination.state === "down" || destination.state === "not_ready";
  const webhookMissing = webhook?.status === "not_registered";
  const nothing = !failedEvents && !unclearCheckouts && !failedDeliveries && !destinationProblem && !webhookMissing;

  return (
    <Card data-testid="needs-attention">
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {nothing ? (
          <p className="text-muted-foreground">Nothing needs attention.</p>
        ) : (
          <ul>
            {webhookMissing && (
              <AttentionItem
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/paypal">Open PayPal</Link>
                  </Button>
                }
              >
                The PayPal webhook isn&apos;t set up{webhook.code ? ` (${webhook.code})` : ""}. Checkouts still work: a buyer&apos;s return captures the
                payment, but a buyer who never returns is only found later.
              </AttentionItem>
            )}
            {destinationProblem && (
              <AttentionItem
                action={
                  <Button size="sm" variant="outline" onClick={() => show({ tab: "sync" })}>
                    Show sync
                  </Button>
                }
              >
                The merchant database is {destination.state}
                {destination.code ? ` (${destination.code})` : ""}
                {destination.downSince ? ` since ${formatTime(destination.downSince)}` : ""}. Payments aren&apos;t affected; copies wait.
              </AttentionItem>
            )}
            {failedDeliveries > 0 && (
              <AttentionItem
                action={
                  <Button size="sm" variant="outline" onClick={() => show({ tab: "sync", deliveries: { status: "failed" } })}>
                    Show
                  </Button>
                }
              >
                {failedDeliveries} {failedDeliveries === 1 ? "delivery was" : "deliveries were"} refused 8 times and stopped.
              </AttentionItem>
            )}
            {failedEvents > 0 && (
              <AttentionItem
                action={
                  <Button size="sm" variant="outline" onClick={() => show({ tab: "events", events: { status: "failed" } })}>
                    Show
                  </Button>
                }
              >
                {failedEvents} PayPal {failedEvents === 1 ? "event" : "events"} failed after 8 attempts.
              </AttentionItem>
            )}
            {unclearCheckouts > 0 && (
              <AttentionItem>
                {unclearCheckouts} {unclearCheckouts === 1 ? "payment has" : "payments have"} been approved or unresolved for over 24 hours, with no
                answer from PayPal. Filter Money by approved or unresolved below.
              </AttentionItem>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function BillingDashboard({ attention }: { attention: AttentionResponse }) {
  const [view, setView] = useState<View>({ tab: "checkouts", checkouts: {}, events: {}, deliveries: {}, version: 0 });
  // A new version remounts the tab, so it starts from the filters it was sent to.
  const show = (next: Partial<View> & { tab: Tab }) => setView((previous) => ({ ...previous, ...next, version: previous.version + 1 }));

  return (
    <div className="flex flex-col gap-6">
      <NeedsAttention attention={attention} show={show} />
      <Tabs value={view.tab} onValueChange={(tab) => setView((previous) => ({ ...previous, tab: tab as Tab }))}>
        <TabsList>
          <TabsTrigger value="checkouts">Checkouts</TabsTrigger>
          {/* Subscriptions (status, paid through, access until) are added when M09 merges. */}
          <TabsTrigger value="subscriptions" disabled title="Added with subscriptions">
            Subscriptions (not built yet)
          </TabsTrigger>
          {/* Credit balances per customer are added when M11 merges. */}
          <TabsTrigger value="credits" disabled title="Added with the credit ledger">
            Credits (not built yet)
          </TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="sync">Sync</TabsTrigger>
        </TabsList>
        <TabsContent value="checkouts" className="pt-2">
          <CheckoutsTab key={view.version} initial={view.checkouts} />
        </TabsContent>
        <TabsContent value="events" className="pt-2">
          <EventsTab key={view.version} initial={view.events} />
        </TabsContent>
        <TabsContent value="sync" className="pt-2">
          <SyncTab key={view.version} initial={view.deliveries} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
