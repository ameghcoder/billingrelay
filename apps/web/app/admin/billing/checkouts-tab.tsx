"use client";

import { FULFILLMENT_STATUSES } from "@billingrelay/core/checkouts";
import { formatPrice } from "@billingrelay/core/catalog";
import type { ColDef } from "ag-grid-community";
import { useState } from "react";
import { DataGrid } from "@/components/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CustomerCell, FilterSelect, ListStatus, PAGE_SIZE, Pager, formatTime, useAdminList } from "./list-controls";
import { DASHBOARD_MONEY, DASHBOARD_SYNC_FILTERS, type CheckoutList, type CheckoutQuery, type DashboardCheckoutRow } from "@billingrelay/core/dashboard";

export type CheckoutFilterValues = Pick<CheckoutQuery, "money" | "fulfillment" | "sync">;

// Money arrived but the merchant's database doesn't have it yet.
export const PAID_NOT_SYNCED: CheckoutFilterValues = { money: "captured", sync: "not_delivered" };

const columns: ColDef<DashboardCheckoutRow>[] = [
  { field: "createdAt", headerName: "Created", minWidth: 170, flex: 2, valueFormatter: ({ value }) => formatTime(value) },
  { field: "externalCustomerId", headerName: "Customer", minWidth: 150, flex: 2, cellRenderer: CustomerCell },
  { field: "productRef", headerName: "Product", minWidth: 120, flex: 2 },
  {
    field: "amount",
    headerName: "Amount",
    minWidth: 100,
    flex: 1,
    valueFormatter: ({ data }) => (data ? formatPrice(data.amount, data.currency) : ""),
  },
  {
    field: "money",
    headerName: "Money",
    minWidth: 120,
    flex: 1,
    valueFormatter: ({ data }) => (data ? (data.moneyReason ? `${data.money} (${data.moneyReason})` : data.money) : ""),
  },
  { field: "fulfillment", headerName: "Fulfillment", minWidth: 110, flex: 1 },
  { field: "sync", headerName: "Sync", minWidth: 110, flex: 1 },
  {
    headerName: "PayPal order / capture",
    minWidth: 190,
    flex: 2,
    valueGetter: ({ data }) => [data?.paypalOrderId, data?.paypalCaptureId].filter(Boolean).join(" / "),
  },
];

export function CheckoutsTab({ initial }: { initial: CheckoutFilterValues }) {
  const [filters, setFilters] = useState<CheckoutFilterValues>(initial);
  const [offset, setOffset] = useState(0);
  const { body, failure, loading } = useAdminList<CheckoutList>("/admin/billing/checkouts", { ...filters, limit: PAGE_SIZE, offset });

  const apply = (next: CheckoutFilterValues) => {
    setFilters(next);
    setOffset(0);
  };
  const isPreset = filters.money === PAID_NOT_SYNCED.money && filters.sync === PAID_NOT_SYNCED.sync && !filters.fulfillment;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect id="money" label="Money" value={filters.money} options={DASHBOARD_MONEY} onChange={(money) => apply({ ...filters, money })} />
        <FilterSelect
          id="fulfillment"
          label="Fulfillment"
          value={filters.fulfillment}
          options={FULFILLMENT_STATUSES}
          onChange={(fulfillment) => apply({ ...filters, fulfillment })}
        />
        <FilterSelect id="sync" label="Sync" value={filters.sync} options={DASHBOARD_SYNC_FILTERS} onChange={(sync) => apply({ ...filters, sync })} />
        <Button size="sm" variant={isPreset ? "default" : "outline"} onClick={() => apply(PAID_NOT_SYNCED)}>
          Paid, not synced
        </Button>
        <Button size="sm" variant="ghost" onClick={() => apply({})}>
          Clear
        </Button>
      </div>

      {body && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="currency-totals">
          <span className="text-muted-foreground">{body.total} matching. Totals per currency:</span>
          {body.totals.length === 0 && <span className="text-muted-foreground">none</span>}
          {body.totals.map((total) => (
            <Badge key={total.currency} variant="secondary">
              {formatPrice(total.amount, total.currency)} {total.currency} · {total.count}
            </Badge>
          ))}
        </div>
      )}
      <ListStatus loading={loading} failure={failure} />
      {body && (
        <>
          <DataGrid label="Checkouts" rows={body.rows} columns={columns} rowId={(row) => row.id} />
          <Pager offset={offset} shown={body.rows.length} total={body.total} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
