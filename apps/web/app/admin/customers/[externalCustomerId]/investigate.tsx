"use client";

import type { InvestigationResponse, Repair } from "@billingrelay/core/repairs";
import { useState } from "react";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const KIND_TEXT: Record<Repair["kind"], string> = {
  retry_delivery: "Send this change to your database again",
  retry_event: "Process this PayPal event again",
  retry_sync: "Retry the sync to your database now",
  recheck_payment: "Ask PayPal again about this payment",
};

/** The AI reads this customer's trace and explains; any repair it proposes needs your approval, and is rechecked before it runs. */
export function Investigate({ externalCustomerId }: { externalCustomerId: string }) {
  const [question, setQuestion] = useState("Why is this customer's access missing in my database?");
  const [result, setResult] = useState<InvestigationResponse | null>(null);
  const [action, setAction] = useState<Repair | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function investigate() {
    setBusy(true);
    setFailure(null);
    const response = await callAdminApi<InvestigationResponse>("/admin/investigations", { method: "POST", body: JSON.stringify({ externalCustomerId, question }) });
    if ("failure" in response) setFailure(response.failure);
    else {
      setResult(response.body);
      setAction(response.body.action);
    }
    setBusy(false);
  }

  async function act(step: "approve" | "execute") {
    if (!action) return;
    setBusy(true);
    setFailure(null);
    const response = await callAdminApi<Repair>(`/admin/actions/${action.id}/${step}`, { method: "POST" });
    if ("failure" in response) setFailure(response.failure);
    else setAction(response.body);
    setBusy(false);
  }

  return (
    <Card className="mb-6" data-testid="investigate">
      <CardHeader>
        <CardTitle>Investigate</CardTitle>
        <CardDescription>The AI reads codes and IDs only. It can propose one existing retry; nothing runs until you approve it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="question">Question</Label>
          <div className="flex gap-2">
            <Input id="question" value={question} onChange={(event) => setQuestion(event.target.value)} />
            <Button data-testid="investigate-ask" disabled={busy || !question.trim()} onClick={investigate}>
              {busy && !result ? "Reading…" : "Ask"}
            </Button>
          </div>
        </div>
        {failure && <ApiFailureMessage failure={failure} />}
        {result && !result.report && <p className="text-sm text-muted-foreground">The AI didn&apos;t finish an investigation. Try again.</p>}
        {result?.report && (
          <div className="flex flex-col gap-3 text-sm" data-testid="investigation">
            <div>
              <p className="font-medium">What the records show</p>
              <ul className="list-disc pl-5">
                {result.report.facts.map((fact) => (
                  <li key={fact.text}>
                    {fact.text}
                    {fact.evidence.length > 0 && <span className="ml-1 break-all text-xs text-muted-foreground">({fact.evidence.join(", ")})</span>}
                  </li>
                ))}
              </ul>
            </div>
            <p>
              <span className="font-medium">Likely cause: </span>
              {result.report.inference}
            </p>
            <p className="text-muted-foreground">
              <span className="font-medium">Not known: </span>
              {result.report.uncertainty}
            </p>
            {result.report.operatorStep && (
              <p data-testid="operator-step">
                <span className="font-medium">First, you: </span>
                {result.report.operatorStep}
              </p>
            )}
            {result.proposalDropped && <p className="text-muted-foreground">The AI proposed a repair that wasn&apos;t kept: {result.proposalDropped}</p>}
            {action ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border p-3" data-testid="repair">
                <span>
                  <span className="font-medium">Proposed: </span>
                  {KIND_TEXT[action.kind]}
                  {action.targetId && <span className="ml-1 break-all text-xs text-muted-foreground">({action.targetId})</span>}
                </span>
                <Badge variant={action.status === "executed" ? "default" : "secondary"} data-testid="repair-status">
                  {action.status}
                  {action.outcome ? `: ${action.outcome}` : ""}
                </Badge>
                {action.status === "proposed" && (
                  <Button size="sm" disabled={busy} onClick={() => act("approve")} data-testid="repair-approve">
                    Approve
                  </Button>
                )}
                {action.status === "approved" && (
                  <Button size="sm" disabled={busy} onClick={() => act("execute")} data-testid="repair-run">
                    Run
                  </Button>
                )}
              </div>
            ) : (
              !result.proposalDropped && <p className="text-muted-foreground">No repair proposed.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
