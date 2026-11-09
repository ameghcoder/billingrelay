"use client";

import { OUTBOX_STATUSES, type SyncStatusResponse } from "@billingrelay/core/sync";
import type { ColDef } from "ag-grid-community";
import { useState } from "react";
import { DataGrid } from "@/components/data-grid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerCell, FilterSelect, ListStatus, PAGE_SIZE, Pager, formatSeconds, formatTime, useAdminList } from "./list-controls";
import { OUTBOX_ENTITY_TYPES, type DashboardDeliveryRow, type DeliveryList, type DeliveryQuery } from "@billingrelay/core/dashboard";

export type DeliveryFilterValues = Pick<DeliveryQuery, "status" | "entityType">;

// Two attempts can share a time and record, so each row is keyed by its place in the list.
type Attempt = SyncStatusResponse["attempts"][number] & { rowKey: string };

const deliveryColumns: ColDef<DashboardDeliveryRow>[] = [
  { field: "createdAt", headerName: "Queued", minWidth: 170, flex: 2, valueFormatter: ({ value }) => formatTime(value) },
  { field: "externalCustomerId", headerName: "Customer", minWidth: 150, flex: 2, cellRenderer: CustomerCell },
  {
    field: "entityType",
    headerName: "Record",
    minWidth: 130,
    flex: 2,
    valueFormatter: ({ data }) => (data ? `${data.entityType} v${data.sourceVersion}` : ""),
  },
  { field: "status", headerName: "Status", minWidth: 100, flex: 1 },
  { field: "attempts", headerName: "Attempts", minWidth: 90, flex: 1 },
  { field: "failureCode", headerName: "Failure code", minWidth: 140, flex: 2 },
  {
    headerName: "Last attempt",
    minWidth: 160,
    flex: 2,
    valueGetter: ({ data }) => {
      const last = data?.lastAttempt;
      if (!last) return "";
      return [last.outcome, last.code, last.durationMs === null ? null : `${last.durationMs} ms`].filter(Boolean).join(" · ");
    },
  },
  { field: "lagSeconds", headerName: "Lag", minWidth: 80, flex: 1, valueFormatter: ({ value }) => formatSeconds(value) },
];

const attemptColumns: ColDef<Attempt>[] = [
  { field: "at", headerName: "When", minWidth: 170, flex: 2, valueFormatter: ({ value }) => formatTime(value) },
  { field: "outcome", headerName: "Outcome", minWidth: 110, flex: 1 },
  { field: "code", headerName: "Code", minWidth: 140, flex: 2 },
  {
    field: "entityType",
    headerName: "Record",
    minWidth: 130,
    flex: 2,
    valueFormatter: ({ data }) => (data?.entityType ? data.entityType : "destination check"),
  },
  { field: "durationMs", headerName: "Duration", minWidth: 90, flex: 1, valueFormatter: ({ value }) => (value === null ? "" : `${value} ms`) },
];

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value || "—"}</dd>
    </div>
  );
}

export function SyncTab({ initial }: { initial: DeliveryFilterValues }) {
  const [filters, setFilters] = useState<DeliveryFilterValues>(initial);
  const [offset, setOffset] = useState(0);
  const overview = useAdminList<SyncStatusResponse>("/admin/sync", {});
  const deliveries = useAdminList<DeliveryList>("/admin/billing/deliveries", { ...filters, limit: PAGE_SIZE, offset });

  const apply = (next: DeliveryFilterValues) => {
    setFilters(next);
    setOffset(0);
  };
  const status = overview.body;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Merchant database</CardTitle>
        </CardHeader>
        <CardContent>
          <ListStatus loading={overview.loading && !status} failure={overview.failure} />
          {status && (
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Fact label="State" value={status.destination.code ? `${status.destination.state} (${status.destination.code})` : status.destination.state} />
              <Fact label="Down since" value={formatTime(status.destination.downSince)} />
              <Fact label="Waiting / failed" value={`${status.pending} / ${status.failed}`} />
              <Fact label="Lag" value={formatSeconds(status.lagSeconds)} />
              <Fact label="Last delivery" value={formatTime(status.lastDeliveredAt)} />
              <Fact label="Next check" value={formatTime(status.destination.nextTryAt)} />
            </dl>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Deliveries</h2>
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect id="delivery-status" label="Status" value={filters.status} options={OUTBOX_STATUSES} onChange={(value) => apply({ ...filters, status: value })} />
          <FilterSelect
            id="delivery-record"
            label="Record"
            value={filters.entityType}
            options={OUTBOX_ENTITY_TYPES}
            onChange={(entityType) => apply({ ...filters, entityType })}
          />
        </div>
        <ListStatus loading={deliveries.loading} failure={deliveries.failure} />
        {deliveries.body && (
          <>
            <DataGrid label="Deliveries" rows={deliveries.body.rows} columns={deliveryColumns} rowId={(row) => row.id} />
            <Pager offset={offset} shown={deliveries.body.rows.length} total={deliveries.body.total} onChange={setOffset} />
          </>
        )}
      </div>

      {status && status.attempts.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Last 20 attempts</h2>
          <DataGrid
            label="Recent sync attempts"
            rows={status.attempts.map((attempt, index) => ({ ...attempt, rowKey: String(index) }))}
            columns={attemptColumns}
            rowId={(row) => row.rowKey}
          />
        </div>
      )}
    </div>
  );
}
