"use client";

import type { AiDraftResponse } from "@billingrelay/core/ai-setup";
import { formatPrice, type CatalogConfig } from "@billingrelay/core/catalog";
import Link from "next/link";
import { useState } from "react";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Turn = { role: "user" | "assistant"; content: string };
type Proposal = Extract<AiDraftResponse, { outcome: "proposal" }>;

const EXAMPLE = "A $19 monthly Pro plan with 2,000 credits a month, a $5 pack of 1,000 extra credits, and a template sold with a $9 standard or $29 extended license.";

function benefitText(benefits: { kind: string; key?: string; amount?: number }[]) {
  return benefits.map((benefit) => (benefit.kind === "access" ? `access: ${benefit.key}` : `${benefit.amount?.toLocaleString()} credits`)).join(", ") || "nothing";
}

function ProposalView({ proposal }: { proposal: Proposal }) {
  const config = proposal.config as CatalogConfig;
  const status = (ref: string) => (proposal.diff.added.includes(ref) ? "new" : proposal.diff.changed.includes(ref) ? "changed" : "unchanged");
  return (
    <div className="flex flex-col gap-3" data-testid="proposal">
      {proposal.note && <p className="text-sm">{proposal.note}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1">Product</th>
            <th>Kind</th>
            <th>Variant</th>
            <th>Price</th>
            <th>Grants</th>
          </tr>
        </thead>
        <tbody>
          {config.products.flatMap((product) =>
            product.variants.map((variant, index) => (
              <tr key={`${product.ref}/${variant.ref}`} className="border-t">
                <td className="py-1">
                  {index === 0 && (
                    <>
                      {product.name} <Badge variant="outline">{status(product.ref)}</Badge>
                    </>
                  )}
                </td>
                <td>{index === 0 ? product.kind.replace("_", " ") : ""}</td>
                <td>{variant.name}</td>
                <td>
                  {formatPrice(variant.price.amount, variant.price.currency)}
                  {product.kind === "subscription" ? " / month" : ""}
                </td>
                <td>{benefitText(variant.benefits)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      {proposal.diff.removed.length > 0 && <p className="text-sm text-destructive">Removes from the live catalog: {proposal.diff.removed.join(", ")}</p>}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">The exact catalog JSON</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify(config, null, 2)}</pre>
      </details>
    </div>
  );
}

/** Hand-rolled: a short chat needs a text box and a list, which Shadcn's primitives already cover. */
export function AiSetup({ available, latestVersion }: { available: boolean; latestVersion: number }) {
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const [result, setResult] = useState<AiDraftResponse | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [base, setBase] = useState(latestVersion);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function ask() {
    setBusy(true);
    setFailure(null);
    setSaved(null);
    const sent = message.trim();
    const response = await callAdminApi<AiDraftResponse>("/admin/ai/draft", { method: "POST", body: JSON.stringify({ message: sent, history }) });
    if ("failure" in response) setFailure(response.failure);
    else {
      setResult(response.body);
      const reply = response.body.outcome === "questions" ? response.body.questions.join("\n") : response.body.note || "Proposed a catalog.";
      const turns: Turn[] = [...history, { role: "user", content: sent }, { role: "assistant", content: reply }];
      setHistory(turns.slice(-12));
      setMessage("");
    }
    setBusy(false);
  }

  async function save(proposal: Proposal) {
    setBusy(true);
    setFailure(null);
    const response = await callAdminApi<{ version: number }>("/admin/config/drafts", { method: "POST", body: JSON.stringify({ baseVersion: base, config: proposal.config }) });
    if ("failure" in response) setFailure(response.failure);
    else {
      setSaved(response.body.version);
      setBase(response.body.version);
    }
    setBusy(false);
  }

  if (!available) {
    return <p className="text-sm text-muted-foreground">AI setup needs OPENAI_API_KEY on the server. The catalog editor works without it.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>What do you sell?</CardTitle>
          <CardDescription>Prices, what each one grants, and how often. The AI asks if something's missing instead of guessing.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {history.length > 0 && (
            <ol className="flex flex-col gap-2 text-sm" data-testid="conversation">
              {history.map((turn, index) => (
                <li key={index} className={turn.role === "user" ? "" : "text-muted-foreground"}>
                  <span className="font-medium">{turn.role === "user" ? "You" : "AI"}:</span> <span className="whitespace-pre-line">{turn.content}</span>
                </li>
              ))}
            </ol>
          )}
          <Label htmlFor="ai-message" className="sr-only">
            Message
          </Label>
          <Textarea id="ai-message" data-testid="ai-message" rows={4} value={message} placeholder={EXAMPLE} onChange={(event) => setMessage(event.target.value)} />
          <div className="flex gap-2">
            <Button data-testid="ai-ask" disabled={busy || message.trim() === ""} onClick={ask}>
              {busy ? "Working…" : history.length ? "Send" : "Draft a catalog"}
            </Button>
            {history.length === 0 && (
              <Button variant="outline" disabled={busy} onClick={() => setMessage(EXAMPLE)}>
                Use the example
              </Button>
            )}
          </div>
          {failure && <ApiFailureMessage failure={failure} />}
        </CardContent>
      </Card>

      {result?.outcome === "questions" && (
        <Card data-testid="questions">
          <CardHeader>
            <CardTitle>The AI needs a few answers</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc pl-5 text-sm">
              {result.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {result?.outcome === "no_proposal" && (
        <Card>
          <CardHeader>
            <CardTitle>No new catalog</CardTitle>
            <CardDescription>{result.note || "The AI couldn't make a catalog that passes every rule. Add detail and try again."}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {result?.outcome === "proposal" && (
        <Card>
          <CardHeader>
            <CardTitle>Proposed catalog</CardTitle>
            <CardDescription>
              Checked against every rule{result.liveVersion ? `, compared with live v${result.liveVersion}` : ""}. Nothing is saved until you save it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ProposalView proposal={result} />
            {saved ? (
              <p className="text-sm" data-testid="saved">
                Saved as v{saved}, not live and not approved.{" "}
                <Link className="underline" href={`/admin/catalog?version=${saved}`}>
                  Review and approve it in Catalog
                </Link>
                .
              </p>
            ) : (
              <div>
                <Button data-testid="ai-save" disabled={busy} onClick={() => save(result)}>
                  Save as a new version
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
