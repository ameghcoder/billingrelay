"use client";

import type { CreditList, DashboardCreditRow } from "@billingrelay/core/dashboard";
import type { ColDef } from "ag-grid-community";
import { useState } from "react";
import { DataGrid } from "@/components/data-grid";
import { CustomerCell, ListStatus, PAGE_SIZE, Pager, formatTime, useAdminList } from "./list-controls";

const columns: ColDef<DashboardCreditRow>[] = [
  { field: "externalCustomerId", headerName: "Customer", minWidth: 150, flex: 2, cellRenderer: CustomerCell },
  { field: "total", headerName: "Spendable", minWidth: 100, flex: 1 },
  { field: "monthly", headerName: "Monthly", minWidth: 100, flex: 1 },
  { field: "packs", headerName: "Packs", minWidth: 100, flex: 1 },
  { field: "restricted", headerName: "Restricted", minWidth: 100, flex: 1 },
  { field: "monthlyEndsAt", headerName: "Monthly ends", minWidth: 170, flex: 2, valueFormatter: ({ value }) => (value ? formatTime(value) : "") },
  { field: "updatedAt", headerName: "Last change", minWidth: 170, flex: 2, valueFormatter: ({ value }) => formatTime(value) },
];

export function CreditsTab() {
  const [offset, setOffset] = useState(0);
  const { body, failure, loading } = useAdminList<CreditList>("/admin/billing/credits", { limit: PAGE_SIZE, offset });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Monthly credits stop counting at their end even before the worker records it. Restricted credits came from a refunded pack.</p>
      <ListStatus loading={loading} failure={failure} />
      {body && (
        <>
          <DataGrid label="Credit balances" rows={body.rows} columns={columns} rowId={(row) => row.accountId} />
          <Pager offset={offset} shown={body.rows.length} total={body.total} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
