"use client";

import type { DashboardSubscriptionRow, SubscriptionList, SubscriptionQuery } from "@billingrelay/core/dashboard";
import { SUBSCRIPTION_STATUSES } from "@billingrelay/core/subscriptions";
import type { ColDef } from "ag-grid-community";
import { useState } from "react";
import { DataGrid } from "@/components/data-grid";
import { CustomerCell, FilterSelect, ListStatus, PAGE_SIZE, Pager, formatTime, useAdminList } from "./list-controls";

export type SubscriptionFilterValues = Pick<SubscriptionQuery, "status">;

const columns: ColDef<DashboardSubscriptionRow>[] = [
  { field: "externalCustomerId", headerName: "Customer", minWidth: 150, flex: 2, cellRenderer: CustomerCell },
  { field: "productRef", headerName: "Product", minWidth: 120, flex: 2 },
  { field: "status", headerName: "PayPal status", minWidth: 110, flex: 1 },
  { field: "reviewReason", headerName: "Review", minWidth: 130, flex: 1 },
  { field: "paidThrough", headerName: "Paid through", minWidth: 170, flex: 2, valueFormatter: ({ value }) => (value ? formatTime(value) : "") },
  { field: "accessUntil", headerName: "Access until", minWidth: 170, flex: 2, valueFormatter: ({ value }) => (value ? formatTime(value) : "") },
  { field: "cancelRequested", headerName: "Cancel asked", minWidth: 110, flex: 1, valueFormatter: ({ value }) => (value ? "yes" : "") },
];

export function SubscriptionsTab({ initial }: { initial: SubscriptionFilterValues }) {
  const [filters, setFilters] = useState<SubscriptionFilterValues>(initial);
  const [offset, setOffset] = useState(0);
  const { body, failure, loading } = useAdminList<SubscriptionList>("/admin/billing/subscriptions", { ...filters, limit: PAGE_SIZE, offset });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="subscription-status"
          label="Status"
          value={filters.status}
          options={SUBSCRIPTION_STATUSES}
          onChange={(status) => {
            setFilters({ status });
            setOffset(0);
          }}
        />
      </div>
      <ListStatus loading={loading} failure={failure} />
      {body && (
        <>
          <DataGrid label="Subscriptions" rows={body.rows} columns={columns} rowId={(row) => row.id} />
          <Pager offset={offset} shown={body.rows.length} total={body.total} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
