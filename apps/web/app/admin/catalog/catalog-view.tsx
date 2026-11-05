"use client";

import {
  formatPrice,
  type CatalogBenefit,
  type CatalogProduct,
  type CatalogVersionDetail,
  type CatalogVersionSummary,
} from "@billingrelay/core/catalog";
import type { ColDef } from "ag-grid-community";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DataGrid } from "@/components/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { KIND_LABELS, MONTHLY_CREDITS_RULE, PACK_CREDITS_RULE } from "./labels";

type ProductRow = {
  id: string;
  product: string;
  productRef: string;
  variant: string;
  kind: string;
  attributes: string;
  amount: number;
  currency: string;
  grants: string;
  refs: string;
};

const grantLabel = (product: CatalogProduct, benefit: CatalogBenefit) => {
  if (benefit.kind === "access") return `Access: ${benefit.key}`;
  const credits = `${benefit.amount.toLocaleString("en-US")} credits`;
  return product.kind === "subscription" ? `${credits} each paid month` : credits;
};

const toRows = (products: CatalogProduct[]): ProductRow[] =>
  products.flatMap((product) =>
    product.variants.map((variant) => ({
      id: `${product.ref}/${variant.ref}`,
      product: product.name,
      productRef: product.ref,
      variant: variant.name,
      kind: KIND_LABELS[product.kind],
      attributes: Object.entries(variant.attributes)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", "),
      amount: variant.price.amount,
      currency: variant.price.currency,
      grants: (variant.benefits as CatalogBenefit[]).map((benefit) => grantLabel(product, benefit)).join(", ") || "Nothing extra",
      refs: `${product.ref} / ${variant.ref}`,
    })),
  );

const productColumns: ColDef<ProductRow>[] = [
  { field: "product", headerName: "Product", flex: 2, minWidth: 130 },
  { field: "variant", headerName: "Variant", flex: 1, minWidth: 100 },
  { field: "kind", headerName: "Kind", flex: 1, minWidth: 110 },
  { field: "attributes", headerName: "Attributes", flex: 1, minWidth: 110 },
  {
    field: "amount",
    headerName: "Price",
    width: 110,
    valueFormatter: ({ data }) => (data ? formatPrice(data.amount, data.currency) : ""),
  },
  { field: "grants", headerName: "Grants", flex: 2, minWidth: 130 },
  { field: "refs", headerName: "Refs for checkout", flex: 2, minWidth: 150 },
];

const editColumn: ColDef<ProductRow> = {
  headerName: "",
  width: 70,
  sortable: false,
  cellRenderer: ({ data }: { data?: ProductRow }) =>
    data && (
      <Link className="underline" href={`/admin/catalog/product?ref=${encodeURIComponent(data.productRef)}`}>
        Edit
      </Link>
    ),
};

const editableProductColumns = [...productColumns, editColumn];

const versionColumns: ColDef<CatalogVersionSummary>[] = [
  { field: "version", headerName: "Version", width: 100, valueFormatter: ({ value }) => `v${value}` },
  { field: "isLive", headerName: "Status", width: 110, valueFormatter: ({ value }) => (value ? "Live" : "Not live") },
  { field: "productCount", headerName: "Products", width: 110 },
  {
    field: "createdAt",
    headerName: "Saved",
    flex: 1,
    minWidth: 180,
    valueFormatter: ({ value }) => new Date(value).toLocaleString(),
  },
  {
    headerName: "",
    width: 80,
    sortable: false,
    cellRenderer: ({ data }: { data?: CatalogVersionSummary }) =>
      data && (
        <Link className="underline" href={`/admin/catalog?version=${data.version}`}>
          View
        </Link>
      ),
  },
];

function JsonBlock({ value, label }: { value: unknown; label: string }) {
  return (
    <pre aria-label={label} className="max-h-[32rem] overflow-auto rounded-lg border bg-muted p-4 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function CatalogView({
  versions,
  selected,
}: {
  versions: CatalogVersionSummary[];
  selected: CatalogVersionDetail | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const live = versions.find((version) => version.isLive);
  const isLatest = selected?.id === versions[0]?.id;
  const productRows = useMemo(() => (selected ? toRows(selected.config.products) : []), [selected]);

  async function makeLive(version: CatalogVersionDetail) {
    setBusy(true);
    setFailure(null);
    const result = await callAdminApi(`/admin/config/drafts/${version.id}/activate`, { method: "POST" });
    if ("failure" in result) setFailure(result.failure);
    else router.refresh();
    setBusy(false);
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Catalog</h1>
          <p className="mt-2 text-muted-foreground" data-testid="live-version">
            {live ? `v${live.version} is live. New checkouts use it.` : "Nothing is live yet."}
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/catalog/product">Add product</Link>
        </Button>
      </div>

      {!selected ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>No products yet</CardTitle>
            <CardDescription>Add your first product. It's saved as version 1, and you choose when it goes live.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2" data-testid="selected-version">
                Version {selected.version}
                <Badge variant={selected.isLive ? "default" : "secondary"}>{selected.isLive ? "Live" : "Not live"}</Badge>
              </CardTitle>
              <CardDescription>
                {selected.isLive
                  ? "This is the version new checkouts use."
                  : "Saved, but not in use. Checkouts already started keep the price they started with."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {!selected.isLive && (
                <div>
                  <Button disabled={busy} onClick={() => makeLive(selected)}>
                    {busy ? "Working…" : `Make v${selected.version} live`}
                  </Button>
                </div>
              )}
              {failure && <ApiFailureMessage failure={failure} />}

              <Tabs defaultValue="products">
                <TabsList>
                  <TabsTrigger value="products">Products</TabsTrigger>
                  <TabsTrigger value="json">Stored JSON</TabsTrigger>
                  <TabsTrigger value="schema">JSON Schema</TabsTrigger>
                </TabsList>
                <TabsContent value="products" className="flex flex-col gap-3">
                  <DataGrid
                    label="Products"
                    rows={productRows}
                    columns={isLatest ? editableProductColumns : productColumns}
                    rowId={(row) => row.id}
                  />
                  {!isLatest && <p className="text-sm text-muted-foreground">Older versions can't be edited. Edits start from the latest version.</p>}
                  <p className="text-sm text-muted-foreground">
                    {MONTHLY_CREDITS_RULE} {PACK_CREDITS_RULE}
                  </p>
                </TabsContent>
                <TabsContent value="json">
                  <JsonBlock value={selected.config} label="Stored JSON" />
                </TabsContent>
                <TabsContent value="schema" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    What each product's variant attributes must match. It's generated from the same fields as the validation.
                  </p>
                  {selected.attributeSchemas.map(({ productRef, schema }) => (
                    <div key={productRef} className="flex flex-col gap-1">
                      <h3 className="text-sm font-medium">{productRef}</h3>
                      <JsonBlock value={schema} label={`JSON Schema for ${productRef}`} />
                    </div>
                  ))}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Version history</CardTitle>
              <CardDescription>Saved versions never change. To go back, view an older version and make it live.</CardDescription>
            </CardHeader>
            <CardContent>
              <DataGrid label="Version history" rows={versions} columns={versionColumns} rowId={(row) => row.id} />
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
