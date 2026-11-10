import { attentionSchema } from "@billingrelay/core/dashboard";
import { getDashboardAttention } from "@billingrelay/db";
import { jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** Counts and codes for what needs a person. Each only warns: nothing here blocks a checkout. */
export const GET = withProject(async ({ projectId }) => jsonResponse(attentionSchema.parse(await getDashboardAttention(sandboxScope(projectId)))));
