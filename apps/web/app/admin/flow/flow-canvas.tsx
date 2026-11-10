"use client";

import type { Flow, FlowNode, FlowSetting } from "@billingrelay/core/flow";
import { Background, Controls, Handle, Position, ReactFlow, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ApiFailureMessage, callAdminApi, type ApiFailure } from "@/components/admin-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type StageNode = Node<{ node: FlowNode }, "stage">;
type VersionInfo = { id: string; version: number; isLive: boolean; approved: boolean; isLatest: boolean };

const TONES = { good: "default", warn: "secondary", bad: "destructive" } as const;
const NODE_WIDTH = 224;
const NODE_HEIGHT = 120;

function StageNodeView({ data, selected }: NodeProps<StageNode>) {
  const { node } = data;
  return (
    <div
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`overflow-hidden rounded-md border bg-card p-3 text-xs shadow-sm ${selected ? "ring-2 ring-primary" : ""}`}
      data-testid={`flow-node-${node.id}`}
    >
      <Handle type="target" position={Position.Left} />
      <p className="font-medium">{node.title}</p>
      {node.settings.slice(0, 2).map((setting) => (
        <p key={setting.label} className="truncate text-muted-foreground">
          {setting.value}
        </p>
      ))}
      {node.status.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {node.status.map((item) => (
            <Badge key={item.label} variant={TONES[item.tone]}>
              {item.count} {item.label}
            </Badge>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { stage: StageNodeView };

/** A price is typed in currency units; the catalog stores minor units. */
const toInput = (setting: FlowSetting) => (setting.edit?.type === "price" ? (Number(setting.edit.current) / 100).toFixed(2) : String(setting.edit?.current ?? ""));

function editBody(setting: FlowSetting, value: string) {
  const edit = setting.edit!;
  const base = { type: edit.type, productRef: edit.productRef, ...(edit.variantRef && { variantRef: edit.variantRef }) };
  if (edit.type === "product_name") return { ...base, name: value };
  if (edit.type === "access_key") return { ...base, key: value };
  if (edit.type === "price") return { ...base, amount: Math.round(Number(value) * 100) };
  return { ...base, amount: Number(value) };
}

function SettingRow({ setting, version, editable }: { setting: FlowSetting; version: VersionInfo; editable: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(toInput(setting));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const id = `setting-${setting.label.replace(/\W+/g, "-")}`;

  async function save() {
    setBusy(true);
    setFailure(null);
    const result = await callAdminApi<{ version: number }>(`/admin/flow/${version.id}/edit`, { method: "POST", body: JSON.stringify(editBody(setting, value)) });
    if ("failure" in result) {
      setFailure(result.failure);
      setBusy(false);
    } else router.push(`/admin/flow?version=${result.body.version}`);
  }

  if (!setting.edit || !editable) {
    return (
      <div className="text-sm">
        <p className="text-muted-foreground">{setting.label}</p>
        <p>{setting.value}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <Label htmlFor={id}>{setting.label}</Label>
      <div className="flex gap-2">
        <Input id={id} data-testid={id} value={value} onChange={(event) => setValue(event.target.value)} />
        <Button size="sm" disabled={busy || value === toInput(setting)} onClick={save}>
          Save
        </Button>
      </div>
      {failure && <ApiFailureMessage failure={failure} />}
    </div>
  );
}

export function FlowCanvas({ flow, version, versions }: { flow: Flow; version: VersionInfo; versions: { version: number; isLive: boolean }[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(flow.nodes[0]?.id ?? null);
  const nodes = useMemo<StageNode[]>(
    // Sizes given up front, so fitting the view counts every column before the nodes are measured.
    () =>
      flow.nodes.map((node) => ({
        id: node.id,
        type: "stage",
        position: node.position,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: { node },
        selected: node.id === selectedId,
        draggable: false,
      })),
    [flow, selectedId],
  );
  const edges = useMemo(() => flow.edges.map((edge) => ({ ...edge, animated: false })), [flow]);
  const selected = flow.nodes.find((node) => node.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Version:</span>
        {versions.slice(0, 8).map((item) => (
          <Link key={item.version} href={`/admin/flow?version=${item.version}`} className={item.version === version.version ? "font-semibold underline" : "underline"}>
            v{item.version}
            {item.isLive ? " (live)" : ""}
          </Link>
        ))}
        <Badge variant={version.approved ? "default" : "secondary"} data-testid="flow-approval">
          {version.approved ? "Approved" : "Not approved"}
        </Badge>
        {!version.isLive && (
          <Link className="underline" href={`/admin/catalog?version=${version.version}`}>
            Approve or make live in Catalog
          </Link>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="h-[32rem] rounded-md border" data-testid="flow-canvas">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_, node) => setSelectedId(node.id)} fitView fitViewOptions={{ padding: 0.05 }} minZoom={0.2} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <Card data-testid="flow-inspector">
          <CardHeader>
            <CardTitle>{selected?.title ?? "Pick a step"}</CardTitle>
            <CardDescription>
              {version.isLatest ? "Edits save a new version, not approved." : "An older version: open the latest to edit."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {selected?.settings.map((setting) => (
              <SettingRow key={`${selected.id}:${setting.label}`} setting={setting} version={version} editable={version.isLatest} />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
