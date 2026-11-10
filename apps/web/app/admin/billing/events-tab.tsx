"use client";

import { PAYPAL_EVENT_STATUSES, type DashboardEventRow, type EventList, type EventQuery } from "@billingrelay/core/dashboard";
import type { ColDef } from "ag-grid-community";
import { useState } from "react";
import { DataGrid } from "@/components/data-grid";
import { CustomerCell, FilterSelect, ListStatus, PAGE_SIZE, Pager, formatTime, useAdminList } from "./list-controls";

export type EventFilterValues = Pick<EventQuery, "status" | "eventType">;

// No payload column: PayPal's body names the buyer, so it never leaves the database.
const columns: ColDef<DashboardEventRow>[] = [
  { field: "receivedAt", headerName: "Received", minWidth: 170, flex: 2, valueFormatter: ({ value }) => formatTime(value) },
  { field: "eventType", headerName: "Type", minWidth: 200, flex: 3 },
  { field: "status", headerName: "Status", minWidth: 100, flex: 1 },
  { field: "attempts", headerName: "Attempts", minWidth: 90, flex: 1 },
  { field: "failureCode", headerName: "Failure code", minWidth: 140, flex: 2 },
  { field: "externalCustomerId", headerName: "Customer", minWidth: 150, flex: 2, cellRenderer: CustomerCell },
];

export function EventsTab({ initial }: { initial: EventFilterValues }) {
  const [filters, setFilters] = useState<EventFilterValues>(initial);
  const [offset, setOffset] = useState(0);
  const { body, failure, loading } = useAdminList<EventList>("/admin/billing/events", { ...filters, limit: PAGE_SIZE, offset });

  const apply = (next: EventFilterValues) => {
    setFilters(next);
    setOffset(0);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect id="event-status" label="Status" value={filters.status} options={PAYPAL_EVENT_STATUSES} onChange={(status) => apply({ ...filters, status })} />
        <FilterSelect
          id="event-type"
          label="Type"
          value={filters.eventType}
          options={body?.eventTypes ?? (filters.eventType ? [filters.eventType] : [])}
          onChange={(eventType) => apply({ ...filters, eventType })}
        />
      </div>
      <ListStatus loading={loading} failure={failure} />
      {body && (
        <>
          <DataGrid label="PayPal events" rows={body.rows} columns={columns} rowId={(row) => row.id} />
          <Pager offset={offset} shown={body.rows.length} total={body.total} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
