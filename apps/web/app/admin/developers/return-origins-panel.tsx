"use client";

import { addReturnOriginSchema, type AddReturnOrigin, type ReturnOriginSummary } from "@billingrelay/core/checkouts";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ColDef } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { DataGrid } from "@/components/data-grid";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ORIGINS_URL = "/admin/developers/return-origins";

function RemoveButton({ data }: { data?: ReturnOriginSummary }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!data) return null;

  async function remove(id: string) {
    setBusy(true);
    setFailed(false);
    const result = await callAdminApi(`${ORIGINS_URL}/${id}`, { method: "DELETE" });
    setBusy(false);
    if ("failure" in result) {
      setFailed(true);
      return;
    }
    router.refresh();
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(data.id)}>
      {busy ? "Working…" : failed ? "Not removed. Retry" : "Remove"}
    </Button>
  );
}

const columns: ColDef<ReturnOriginSummary>[] = [
  { field: "origin", headerName: "Origin", flex: 3, minWidth: 220 },
  {
    field: "createdAt",
    headerName: "Added",
    flex: 2,
    minWidth: 180,
    valueFormatter: ({ value }) => new Date(value).toLocaleString(),
  },
  { headerName: "", width: 170, sortable: false, cellRenderer: RemoveButton },
];

export function ReturnOriginsPanel({ origins }: { origins: ReturnOriginSummary[] }) {
  const router = useRouter();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const form = useForm<AddReturnOrigin>({ resolver: zodResolver(addReturnOriginSchema), defaultValues: { origin: "" } });

  const add = form.handleSubmit(async (values) => {
    setFailure(null);
    const result = await callAdminApi(ORIGINS_URL, { method: "POST", body: JSON.stringify(values) });
    if ("failure" in result) {
      setFailure(result.failure);
      return;
    }
    form.reset();
    router.refresh();
  });

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Allowed return URLs</CardTitle>
        <CardDescription>
          Where a checkout may send the buyer afterwards. A checkout&apos;s <code className="text-sm">returnUrl</code> must be on one of these origins, so a link can&apos;t
          send buyers to another site.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={add} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="origin">Origin</Label>
            <Input id="origin" autoComplete="off" placeholder="https://app.example.com" {...form.register("origin")} />
            {form.formState.errors.origin && <p className="text-sm text-destructive">{form.formState.errors.origin.message}</p>}
          </div>
          {failure && <ApiFailureMessage failure={failure} />}
          <div>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Working…" : "Add origin"}
            </Button>
          </div>
        </form>
        {origins.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet, so no checkout can start.</p>
        ) : (
          <DataGrid label="Allowed return URLs" rows={origins} columns={columns} rowId={(row) => row.id} />
        )}
      </CardContent>
    </Card>
  );
}
