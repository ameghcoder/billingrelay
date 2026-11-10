import { attentionSchema } from "@billingrelay/core/dashboard";
import { getDashboardAttention, getDefaultProjectId } from "@billingrelay/db";
import { sandboxScope } from "@/lib/admin-routes";
import { requireOperatorPage } from "@/lib/operator";
import { BillingDashboard } from "./billing-dashboard";

export default async function BillingPage() {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;

  const attention = attentionSchema.parse(await getDashboardAttention(sandboxScope(projectId)));
  return (
    <>
      <h1 className="text-2xl font-semibold">Billing</h1>
      <p className="mt-2 mb-6 text-muted-foreground">
        Read-only. Money, fulfillment and sync are separate: a payment can be captured while its copy to your database still waits.
      </p>
      <BillingDashboard attention={attention} />
    </>
  );
}
