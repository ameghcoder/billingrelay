import { externalCustomerIdSchema } from "@billingrelay/core/quotes";
import { getCustomerTrace, getDefaultProjectId } from "@billingrelay/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sandboxScope } from "@/lib/admin-routes";
import { requireOperatorPage } from "@/lib/operator";
import { customerTraceSchema } from "@billingrelay/core/dashboard";
import { TraceView } from "./trace-view";

export default async function CustomerPage({ params }: { params: Promise<{ externalCustomerId: string }> }) {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;

  const id = externalCustomerIdSchema.safeParse((await params).externalCustomerId);
  const trace = id.success ? await getCustomerTrace(sandboxScope(projectId), id.data) : null;
  if (!trace) notFound();

  return (
    <>
      <Link href="/admin/billing" className="text-sm text-muted-foreground hover:text-foreground">
        ← Billing
      </Link>
      <h1 className="mt-2 text-2xl font-semibold break-all">Customer {trace.externalCustomerId}</h1>
      <p className="mt-2 mb-6 text-muted-foreground">
        Each checkout, then everything that followed it in time order: PayPal events, billing effects, access, and every copy to your database.
      </p>
      <TraceView trace={customerTraceSchema.parse(trace)} />
    </>
  );
}
