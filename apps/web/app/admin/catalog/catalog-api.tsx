"use client";

import type { CatalogIssue } from "@billingrelay/core/catalog";

export type ApiFailure = { message: string; fields: CatalogIssue[] };

const FALLBACK = "Something went wrong. Try again shortly.";

/** Returns the body on success. On failure, the message and each field the server named. */
export async function callCatalogApi<Body>(path: string, init: RequestInit): Promise<{ body: Body } | { failure: ApiFailure }> {
  try {
    const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
    const body = await response.json().catch(() => null);
    if (response.ok) return { body };
    return { failure: { message: body?.error?.message ?? FALLBACK, fields: body?.error?.details?.fields ?? [] } };
  } catch {
    return { failure: { message: FALLBACK, fields: [] } };
  }
}

export function ApiFailureMessage({ failure }: { failure: ApiFailure }) {
  return (
    <div role="alert" data-testid="catalog-error" className="text-sm text-destructive">
      <p>{failure.message}</p>
      {failure.fields.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {failure.fields.map((field) => (
            <li key={`${field.path}:${field.message}`}>
              <code className="break-all">{field.path}</code>: {field.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
