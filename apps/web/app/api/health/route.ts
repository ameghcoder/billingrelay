import { getDestinationState, getWorkerStatus, pingSource } from "@billingrelay/db";

export const dynamic = "force-dynamic";

// Public, so it returns statuses only: no error text, hosts or versions.
// The destination is reported but never makes this unhealthy: a merchant's database being down mustn't get our checkout restarted.
export async function GET() {
  const [source, worker] = await Promise.all([pingSource(), getWorkerStatus()]);
  const destination = source === "ok" ? await getDestinationState().catch(() => "unknown" as const) : "unknown";
  const healthy = source === "ok" && worker === "ok";
  return Response.json(
    { source, destination, worker },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
