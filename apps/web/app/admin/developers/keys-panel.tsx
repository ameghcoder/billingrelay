"use client";

import { createApiKeySchema, type ApiKeySummary, type CreateApiKey, type CreatedApiKey } from "@billingrelay/core/api-keys";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ColDef } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { DataGrid } from "@/components/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const KEYS_URL = "/admin/developers/api-keys";

function RevokeButton({ data }: { data?: ApiKeySummary }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  if (!data || data.revokedAt) return null;

  async function revoke(id: string) {
    setBusy(true);
    setFailure(null);
    const result = await callAdminApi(`${KEYS_URL}/${id}/revoke`, { method: "POST" });
    setBusy(false);
    if ("failure" in result) {
      setFailure(result.failure);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything still using “{data.name}” stops working on its next request. This can't be undone. Quotes it already created stay as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failure && <ApiFailureMessage failure={failure} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => revoke(data.id)}>
            {busy ? "Working…" : "Revoke key"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const columns: ColDef<ApiKeySummary>[] = [
  { field: "name", headerName: "Name", flex: 2, minWidth: 150 },
  {
    field: "lastFour",
    headerName: "Key",
    flex: 2,
    minWidth: 170,
    valueFormatter: ({ data }) => (data ? `br_${data.environment}_…${data.lastFour}` : ""),
  },
  {
    field: "createdAt",
    headerName: "Created",
    flex: 2,
    minWidth: 180,
    valueFormatter: ({ value }) => new Date(value).toLocaleString(),
  },
  { field: "revokedAt", headerName: "Status", width: 110, valueFormatter: ({ value }) => (value ? "Revoked" : "Active") },
  { headerName: "", width: 120, sortable: false, cellRenderer: RevokeButton },
];

export function KeysPanel({ keys }: { keys: ApiKeySummary[] }) {
  const router = useRouter();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const form = useForm<CreateApiKey>({ resolver: zodResolver(createApiKeySchema), defaultValues: { name: "" } });

  const create = form.handleSubmit(async (values) => {
    setFailure(null);
    const result = await callAdminApi<CreatedApiKey>(KEYS_URL, { method: "POST", body: JSON.stringify(values) });
    if ("failure" in result) {
      setFailure(result.failure);
      return;
    }
    setCreated(result.body);
    setCopied(false);
    form.reset();
    router.refresh();
  });

  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      // The browser refused. The key is still on screen to select by hand.
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">API keys</h1>
      <p className="mt-2 text-muted-foreground">
        Your backend sends a key as <code className="text-sm">Authorization: Bearer &lt;key&gt;</code>. Keep it on your server, never in browser code.
      </p>

      {created && (
        <Card className="mt-6 border-primary">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Copy your new key now
              <Badge variant="secondary">{created.environment}</Badge>
            </CardTitle>
            <CardDescription>This is the only time it's shown. If you lose it, make a new one and revoke this one.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <code data-testid="new-api-key" className="break-all rounded-lg border bg-muted p-3 text-sm">
              {created.key}
            </code>
            <div className="flex gap-2">
              <Button onClick={() => copy(created.key)}>{copied ? "Copied" : "Copy key"}</Button>
              <Button variant="outline" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Create a key</CardTitle>
          <CardDescription>Name it after what will use it. You can have several, so a key can be replaced with no downtime.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-col gap-3" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" autoComplete="off" {...form.register("name")} />
              {form.formState.errors.name && <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>}
            </div>
            {failure && <ApiFailureMessage failure={failure} />}
            <div>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Working…" : "Create key"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys yet.</p>
          ) : (
            <DataGrid label="API keys" rows={keys} columns={columns} rowId={(row) => row.id} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
