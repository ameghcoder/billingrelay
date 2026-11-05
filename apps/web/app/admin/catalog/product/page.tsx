import { getCatalogVersion, getDefaultProjectId, listCatalogVersions } from "@billingrelay/db";
import { notFound } from "next/navigation";
import { sandboxScope } from "@/lib/admin-routes";
import { requireOperatorPage } from "@/lib/operator";
import { ProductForm } from "./product-form";

export default async function ProductPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;

  const scope = sandboxScope(projectId);
  const [latest] = await listCatalogVersions(scope);
  const catalog = latest ? await getCatalogVersion(scope, latest.id) : null;

  const { ref } = await searchParams;
  const editing = ref ? catalog?.config.products.find((product) => product.ref === ref) : undefined;
  if (ref && !editing) notFound();

  return (
    <ProductForm
      key={`${latest?.version ?? 0}:${ref ?? ""}`}
      baseVersion={latest?.version ?? 0}
      products={catalog?.config.products ?? []}
      editing={editing ?? null}
    />
  );
}
