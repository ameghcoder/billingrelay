"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export const PAGE_SIZE = 50;

type Query = Record<string, string | number | undefined>;

/** Fetches one page from an admin GET route whenever the query changes. Filtering and paging happen in SQL. */
export function useAdminList<Body>(path: string, query: Query) {
  const search = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) => (value === undefined || value === "" ? [] : [[key, String(value)]])),
  ).toString();
  const [state, setState] = useState<{ body: Body | null; failure: ApiFailure | null; loading: boolean }>({
    body: null,
    failure: null,
    loading: true,
  });

  useEffect(() => {
    let current = true;
    setState((previous) => ({ ...previous, loading: true }));
    callAdminApi<Body>(`${path}?${search}`, { method: "GET" }).then((result) => {
      if (!current) return;
      setState("failure" in result ? { body: null, failure: result.failure, loading: false } : { body: result.body, failure: null, loading: false });
    });
    return () => {
      current = false;
    };
  }, [path, search]);

  return state;
}

export function ListStatus({ loading, failure }: { loading: boolean; failure: ApiFailure | null }) {
  if (failure) return <ApiFailureMessage failure={failure} />;
  return loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null;
}

export function FilterSelect<Value extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: Value | undefined;
  options: readonly Value[];
  onChange: (value: Value | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} size="sm" value={value ?? ""} onChange={(event) => onChange((event.target.value || undefined) as Value | undefined)}>
        <NativeSelectOption value="">Any</NativeSelectOption>
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

export function Pager({ offset, shown, total, onChange }: { offset: number; shown: number; total: number; onChange: (offset: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
      <span>
        {offset + 1}–{offset + shown} of {total}
      </span>
      <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>
        Previous
      </Button>
      <Button variant="outline" size="sm" disabled={offset + shown >= total} onClick={() => onChange(offset + PAGE_SIZE)}>
        Next
      </Button>
    </div>
  );
}

export const customerPath = (externalCustomerId: string) => `/admin/customers/${encodeURIComponent(externalCustomerId)}`;

/** A grid cell that opens the customer's trace. */
export function CustomerCell({ value }: { value?: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Link href={customerPath(value)} className="underline underline-offset-2 hover:text-foreground">
      {value}
    </Link>
  );
}

export const formatTime = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "");

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
