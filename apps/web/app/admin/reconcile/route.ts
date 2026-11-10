import { reconcileNow } from "@billingrelay/db";
import { jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** Moves what reconciliation looks at to the front of the worker's queue, and says how much there is. The worker does the work. */
export const POST = withProject(async ({ projectId }) => jsonResponse(await reconcileNow(sandboxScope(projectId))));
