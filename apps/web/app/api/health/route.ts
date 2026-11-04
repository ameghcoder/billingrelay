import { getWorkerStatus, pingDestination, pingSource } from "@billingrelay/db";

export const dynamic = "force-dynamic";

// Public, so it returns statuses only: no error text, hosts or versions.
export async function GET() {
  const [source, destination, worker] = await Promise.all([pingSource(), pingDestination(), getWorkerStatus()]);
  const healthy = source === "ok" && destination !== "down" && worker === "ok";
  return Response.json(
    { source, destination, worker },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
