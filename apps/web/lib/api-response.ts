import { toFieldIssues } from "@billingrelay/core/catalog";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "no-store" };

export const jsonResponse = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export const apiError = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  Response.json({ error: { code, message, ...(details && { details }) } }, { status, headers: NO_STORE });

export const invalidRequest = (error: z.ZodError) =>
  apiError(400, "invalid_request", "The request has errors", { fields: toFieldIssues(error) });

export const isUuid = (id: string) => z.uuid().safeParse(id).success;
