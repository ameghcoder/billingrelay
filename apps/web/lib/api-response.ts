import { toFieldIssues } from "@billingrelay/core/catalog";
import { z } from "zod";

const NO_STORE = { "Cache-Control": "no-store" };

export const jsonResponse = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export const apiError = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  Response.json({ error: { code, message, ...(details && { details }) } }, { status, headers: NO_STORE });

export const invalidRequest = (error: z.ZodError) =>
  apiError(400, "invalid_request", "The request has errors", { fields: toFieldIssues(error) });

export const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** Stops reading at the limit, because a body with no declared length could otherwise fill the server's memory. `null` means too large. */
export async function readBodyUpTo(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.length;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
