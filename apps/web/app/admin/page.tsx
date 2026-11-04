import { requireOperatorPage } from "@/lib/operator";

export default async function AdminPage() {
  await requireOperatorPage();
  return (
    <>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-muted-foreground">Billing data appears here once a project is connected.</p>
    </>
  );
}
