import { syncStatusResponseSchema } from "@billingrelay/core/sync";
import { getSyncOverview } from "@billingrelay/db";
import { jsonResponse, withProject } from "@/lib/admin-routes";

/** Destination state, lag and recent attempts. Read from our own database: the web app never connects to the destination. */
export const GET = withProject(async () => jsonResponse(syncStatusResponseSchema.parse(await getSyncOverview())));
