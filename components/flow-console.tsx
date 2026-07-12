"use client";

import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import {
  Activity,
  FileUp,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FlowNode } from "@/components/flow-node";
import { StatusBadge, StatusIcon, statusClass } from "@/components/status";
import { STEP_EDGES, createInitialSteps } from "@/lib/flow/steps";
import type {
  DemoLogBundle,
  FlowMode,
  FlowRun,
  FlowStep,
  RunListItem,
  StepId,
} from "@/lib/flow/types";

type EnvironmentPayload = {
  gateway: { ok: boolean; status: number; error?: string };
  localstack: { ok: boolean; status: number; error?: string };
  config: Record<string, unknown>;
};

const nodeTypes = { flowNode: FlowNode };
const initialSteps = createInitialSteps();

const positions: Record<StepId, { x: number; y: number }> = {
  localstack: { x: 0, y: 0 },
  cognito: { x: 300, y: 0 },
  "gateway-upload": { x: 600, y: 0 },
  idempotency: { x: 900, y: 0 },
  "gateway-validation": { x: 1200, y: 0 },
  "s3-store": { x: 1200, y: 190 },
  "gateway-outbox": { x: 900, y: 190 },
  "outbox-publish": { x: 600, y: 190 },
  "sns-sqs": { x: 300, y: 190 },
  "dlq-observability": { x: 0, y: 190 },
  "processor-consume": { x: 0, y: 380 },
  "s3-read": { x: 300, y: 380 },
  "processor-analysis": { x: 600, y: 380 },
  "dynamodb-metadata": { x: 900, y: 380 },
  "result-outbox": { x: 1200, y: 380 },
};

const evidenceKeys = [
  "fileId",
  "correlationId",
  "requestId",
  "idempotencyKey",
  "responseStatus",
  "bucketName",
  "objectKey",
  "serverSideEncryption",
  "sseKmsKeyId",
  "kmsKeyArn",
  "recordStatus",
  "outboxStatus",
  "publishPath",
  "runtimeMode",
  "localParityMode",
  "directPublishAfterOutbox",
  "fileEventsTopicArn",
  "processingEventsTopicArn",
  "outboxPublisherLambdaName",
  "processorLambdaName",
  "eventType",
  "fileHash",
  "isSafe",
  "messagesAvailable",
  "messagesInFlight",
  "dlqMessages",
  "cloudwatchService",
  "cloudwatchLogsService",
];

const logLabels: Record<string, string> = {
  "fsamp-e2e-gateway": "Gateway",
  "fsamp-e2e-processor": "Processor",
  "fsamp-e2e-localstack": "LocalStack",
  "/aws/lambda/fsamp-local-outbox-publisher": "Outbox Lambda",
  "/aws/lambda/fsamp-local-processor": "Processor Lambda",
  "/ecs/fsamp-local": "ECS Gateway",
};

function formatTime(value?: string) {
  if (!value) return "n/a";
  return new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function getSelectedStep(steps: FlowStep[], selectedStepId: StepId | undefined) {
  return steps.find((step) => step.id === selectedStepId) ?? steps[0];
}

function edgeStatus(steps: FlowStep[], source: StepId, target: StepId) {
  const sourceStep = steps.find((step) => step.id === source);
  const targetStep = steps.find((step) => step.id === target);
  if (sourceStep?.status === "failed" || targetStep?.status === "failed") return "failed";
  if (sourceStep?.status === "success" && targetStep?.status === "success") return "success";
  if (sourceStep?.status === "success" || targetStep?.status === "running") return "running";
  if (sourceStep?.status === "skipped" || targetStep?.status === "skipped") return "skipped";
  return "pending";
}

function edgeColor(status: string) {
  if (status === "success") return "#34d399";
  if (status === "failed") return "#f87171";
  if (status === "running") return "#38bdf8";
  if (status === "skipped") return "#71717a";
  return "#3f3f46";
}

function shortValue(value?: string) {
  if (!value) return "n/a";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatEvidenceValue(value: unknown) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return prettyJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function evidenceHighlights(step?: FlowStep) {
  if (!step?.evidence) return [];
  const source = step.evidence;
  const nested = isRecord(source.event) ? source.event : undefined;
  const item = isRecord(source.item) ? source.item : undefined;

  return evidenceKeys
    .map((key) => {
      const value = source[key] ?? nested?.[key] ?? item?.[key];
      return value === undefined ? undefined : { key, value: formatEvidenceValue(value) };
    })
    .filter((entry): entry is { key: string; value: string } => Boolean(entry))
    .slice(0, 8);
}

function healthClass(ok?: boolean) {
  return ok ? "bg-emerald-400" : "bg-red-400";
}

function normalizeSteps(steps: FlowStep[]) {
  const storedSteps = new Map(steps.map((step) => [step.id, step]));
  return initialSteps.map((definition) => {
    const stored = storedSteps.get(definition.id);
    if (!stored) return definition;

    return {
      ...definition,
      status: stored.status,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
      evidence: stored.evidence,
      error: stored.error,
    };
  });
}

export function FlowConsole() {
  const [run, setRun] = useState<FlowRun>();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [logs, setLogs] = useState<DemoLogBundle>();
  const [selectedLogName, setSelectedLogName] = useState("fsamp-e2e-gateway");
  const [environment, setEnvironment] = useState<EnvironmentPayload>();
  const [selectedStepId, setSelectedStepId] = useState<StepId>("localstack");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [replayActive, setReplayActive] = useState(false);
  const [visibleStepCount, setVisibleStepCount] = useState<number | undefined>();
  const [flowMounted, setFlowMounted] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  const normalizedSteps = useMemo(() => (run ? normalizeSteps(run.steps) : initialSteps), [run]);

  const loadRuns = useCallback(async () => {
    const response = await fetch("/api/runs", { cache: "no-store" });
    const payload = (await response.json()) as { runs: RunListItem[]; latest?: FlowRun };
    setRuns(payload.runs);
    if (!run && payload.latest) {
      setRun(payload.latest);
      setSelectedStepId(payload.latest.steps[0]?.id ?? "localstack");
    }
  }, [run]);

  const loadEnvironment = useCallback(async () => {
    const response = await fetch("/api/environment", { cache: "no-store" });
    setEnvironment((await response.json()) as EnvironmentPayload);
  }, []);

  const loadLogs = useCallback(async (runId: string) => {
    const response = await fetch(`/api/runs/${runId}/logs`, { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as DemoLogBundle;
      setLogs(payload);
      setSelectedLogName((current) =>
        payload.containers.some((container) => container.name === current)
          ? current
          : (payload.containers[0]?.name ?? current),
      );
    }
  }, []);

  const refreshRun = useCallback(async (runId: string) => {
    const response = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as FlowRun;
      setRun(payload);
      setRuns((current) =>
        current.some((item) => item.id === payload.id)
          ? current.map((item) =>
              item.id === payload.id
                ? {
                    id: payload.id,
                    mode: payload.mode,
                    status: payload.status,
                    createdAt: payload.createdAt,
                    updatedAt: payload.updatedAt,
                    fileId: payload.fileId,
                    correlationId: payload.correlationId,
                    filename: payload.input.filename,
                  }
                : item,
            )
          : current,
      );
      return payload;
    }
    return undefined;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadRuns().catch(() => undefined);
      loadEnvironment().catch(() => undefined);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadEnvironment, loadRuns]);

  useEffect(() => {
    const timer = window.setTimeout(() => setFlowMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!run?.id || replayActive) return;

    const logTimer = window.setTimeout(() => {
      loadLogs(run.id).catch(() => undefined);
    }, 0);

    if (run.status !== "running" && run.status !== "idle") {
      return () => window.clearTimeout(logTimer);
    }

    const timer = window.setInterval(() => {
      refreshRun(run.id)
        .then((nextRun) => {
          if (nextRun?.id) return loadLogs(nextRun.id);
        })
        .catch(() => undefined);
    }, 1800);

    return () => {
      window.clearTimeout(logTimer);
      window.clearInterval(timer);
    };
  }, [loadLogs, refreshRun, replayActive, run?.id, run?.status]);

  useEffect(() => {
    if (!replayActive || !run) return;

    let count = 1;
    const startTimer = window.setTimeout(() => {
      setVisibleStepCount(1);
      pollRef.current = window.setInterval(() => {
        count += 1;
        setVisibleStepCount(count);
        if (count >= run.steps.length) {
          setReplayActive(false);
          setVisibleStepCount(undefined);
          if (pollRef.current) window.clearInterval(pollRef.current);
        }
      }, 520);
    }, 0);

    return () => {
      window.clearTimeout(startTimer);
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [replayActive, run]);

  const displayedSteps = useMemo(() => {
    if (!run) return initialSteps;
    if (!replayActive || visibleStepCount === undefined) return normalizedSteps;
    return normalizedSteps.map((step, index) =>
      index < visibleStepCount
        ? step
        : { ...step, status: "pending" as const, evidence: undefined },
    );
  }, [normalizedSteps, replayActive, run, visibleStepCount]);

  const selectedStep = getSelectedStep(displayedSteps, selectedStepId);
  const highlights = evidenceHighlights(selectedStep);

  const nodes: Node[] = useMemo(
    () =>
      displayedSteps.map((step, index) => ({
        id: step.id,
        type: "flowNode",
        position: positions[step.id] ?? { x: (index % 5) * 300, y: Math.floor(index / 5) * 190 },
        data: {
          step,
          selected: selectedStepId === step.id,
          order: index + 1,
        },
      })),
    [displayedSteps, selectedStepId],
  );

  const edges: Edge[] = useMemo(
    () => {
      const nodeIds = new Set(displayedSteps.map((step) => step.id));

      return STEP_EDGES.filter(
        ([source, target]) => nodeIds.has(source) && nodeIds.has(target),
      ).map(([source, target]) => {
        const status = edgeStatus(displayedSteps, source, target);
        return {
          id: `${source}-${target}`,
          source,
          target,
          animated: status === "running",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edgeColor(status),
          },
          style: {
            stroke: edgeColor(status),
            strokeWidth: status === "success" ? 3 : 2,
          },
        };
      });
    },
    [displayedSteps],
  );

  const selectedLogContainer =
    logs?.containers.find((container) => container.name === selectedLogName) ??
    logs?.containers[0];
  const selectedLogLines = selectedLogContainer?.matchedLines ?? [];
  const selectedLogMode = selectedLogContainer?.matchedLines.length ? "matched" : "no matches";

  async function startRun(runMode: FlowMode) {
    setBusy(true);
    setNotice(undefined);

    const form = new FormData();
    form.append("mode", runMode);

    if (selectedFile) {
      form.append("file", selectedFile);
    }

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "X-FSAMP-Demo-Request": "1" },
        body: form,
      });
      const payload = (await response.json()) as FlowRun;
      setRun(payload);
      setSelectedStepId(payload.steps[0]?.id ?? "localstack");
      setReplayActive(false);
      await loadRuns();
      if (payload.id) {
        loadLogs(payload.id).catch(() => undefined);
      }

      if (!response.ok) {
        setNotice(payload.errors[0] ?? "Run failed before full evidence collection.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function replayLatest() {
    const response = await fetch("/api/runs", { cache: "no-store" });
    const payload = (await response.json()) as { runs: RunListItem[]; latest?: FlowRun };
    setRuns(payload.runs);

    const targetRun = run ?? payload.latest;
    if (!targetRun) {
      setNotice("No captured run available for replay.");
      return;
    }

    setRun(targetRun);
    setSelectedStepId(targetRun.steps[0]?.id ?? "localstack");
    setReplayActive(true);
  }

  const skippedSteps = displayedSteps.filter((step) => step.status === "skipped").length;
  const activeSteps = displayedSteps.length - skippedSteps;
  const completedSteps = displayedSteps.filter((step) => step.status === "success").length;
  const successRate = Math.round((completedSteps / Math.max(activeSteps, 1)) * 100);

  return (
    <main className="min-h-screen bg-[#0b0d10] text-zinc-100">
      <div className="border-b border-zinc-800 bg-[#111418]">
        <div className="mx-auto flex max-w-[1760px] flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-cyan-200">
              <Activity className="h-4 w-4" />
              FSAMP Local Flow Console
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-normal text-zinc-50">
              Event-driven file processing trace
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run?.status ?? "idle"} />
            <span className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300">
              {run ? `${completedSteps}/${activeSteps} steps` : "no run"}
            </span>
            <span className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300">
              {run ? run.mode : "mode"}
            </span>
            <button
              type="button"
              onClick={() => {
                loadEnvironment().catch(() => undefined);
                if (run?.id) {
                  refreshRun(run.id)
                    .then((nextRun) => {
                      if (nextRun?.id) return loadLogs(nextRun.id);
                      return undefined;
                    })
                    .catch(() => undefined);
                }
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 hover:border-cyan-400"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1760px] grid-cols-1 gap-4 px-5 py-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <section className="rounded-md border border-zinc-800 bg-[#111418] p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">Run Control</h2>
              <span className="text-xs text-zinc-500">{formatTime(run?.updatedAt)}</span>
            </div>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-2 block text-xs font-medium uppercase tracking-normal text-zinc-500">
                  Input file
                </span>
                <input
                  type="file"
                  onChange={(event) => setSelectedFile(event.target.files?.[0])}
                  className="block w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 file:mr-3 file:rounded-md file:border-0 file:bg-cyan-500 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-950"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => startRun("upload")}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-cyan-400 px-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileUp className="h-4 w-4" />
                  Upload
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => startRun("event")}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm font-semibold text-zinc-100 hover:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  Direct event
                </button>
              </div>

              <button
                type="button"
                onClick={replayLatest}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 hover:border-emerald-400"
              >
                <RotateCcw className="h-4 w-4" />
                Replay captured run
              </button>
            </div>

            {notice ? (
              <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
                {notice}
              </div>
            ) : null}
          </section>

          <section className="rounded-md border border-zinc-800 bg-[#111418] p-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className={`h-2 w-2 rounded-sm ${healthClass(environment?.gateway.ok)}`} />
                  Gateway
                </div>
                <div className={environment?.gateway.ok ? "mt-1 text-emerald-300" : "mt-1 text-red-300"}>
                  {environment?.gateway.ok ? "healthy" : "offline"}
                </div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className={`h-2 w-2 rounded-sm ${healthClass(environment?.localstack.ok)}`} />
                  LocalStack
                </div>
                <div className={environment?.localstack.ok ? "mt-1 text-emerald-300" : "mt-1 text-red-300"}>
                  {environment?.localstack.ok ? "healthy" : "offline"}
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="text-lg font-semibold text-zinc-100">{successRate}%</div>
                <div className="text-[11px] uppercase tracking-normal text-zinc-500">verified</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="text-lg font-semibold text-zinc-100">{activeSteps}</div>
                <div className="text-[11px] uppercase tracking-normal text-zinc-500">active</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="text-lg font-semibold text-zinc-100">{skippedSteps}</div>
                <div className="text-[11px] uppercase tracking-normal text-zinc-500">skipped</div>
              </div>
            </div>
          </section>

          <section className="rounded-md border border-zinc-800 bg-[#111418]">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-zinc-100">Evidence Timeline</h2>
              <Radio className="h-4 w-4 text-cyan-300" />
            </div>
            <div className="max-h-[440px] overflow-auto p-2">
              {displayedSteps.map((step, index) => (
                <button
                  type="button"
                  key={step.id}
                  onClick={() => setSelectedStepId(step.id)}
                  className={`mb-2 grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2 text-left ${
                    selectedStepId === step.id
                      ? "border-cyan-400 bg-cyan-400/10"
                      : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"
                  }`}
                >
                  <span className="text-xs text-zinc-500">{String(index + 1).padStart(2, "0")}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-100">{step.shortLabel}</span>
                    <span className="block truncate text-xs text-zinc-500">{step.component}</span>
                  </span>
                  <span className={`rounded-md border px-2 py-1 text-[11px] uppercase ${statusClass(step.status)}`}>
                    {step.status}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-zinc-800 bg-[#111418]">
            <div className="border-b border-zinc-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-zinc-100">Recent runs</h2>
            </div>
            <div className="max-h-[300px] space-y-2 overflow-auto p-2">
              {runs.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => {
                    refreshRun(item.id)
                      .then((nextRun) => {
                        if (nextRun?.id) return loadLogs(nextRun.id);
                        return undefined;
                      })
                      .catch(() => undefined);
                    setReplayActive(false);
                  }}
                  className={`block w-full rounded-md border p-3 text-left ${
                    item.id === run?.id
                      ? "border-cyan-400 bg-cyan-400/10"
                      : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">{item.filename}</span>
                    <span className="text-xs uppercase text-zinc-500">{item.mode}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-500">
                    <span className="truncate">{shortValue(item.fileId)}</span>
                    <span>{formatTime(item.createdAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="space-y-4">
          <section className="overflow-hidden rounded-md border border-zinc-800 bg-[#111418]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-100">Flow Map</h2>
                <div className="mt-1 truncate text-xs text-zinc-500">
                  {shortValue(run?.fileId)} · {shortValue(run?.correlationId)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-300" />
                <span className="text-sm text-zinc-300">{successRate}% verified</span>
              </div>
            </div>

            <div className="h-[610px] bg-[#0d1014]">
              {flowMounted ? (
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.18 }}
                  minZoom={0.45}
                  maxZoom={1.4}
                  onNodeClick={(_, node) => setSelectedStepId(node.id as StepId)}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background color="#27272a" gap={22} />
                  <Controls className="!border-zinc-700 !bg-zinc-950 !text-zinc-100" />
                </ReactFlow>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                  Loading flow map
                </div>
              )}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <section className="rounded-md border border-zinc-800 bg-[#111418]">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-zinc-100">
                    {selectedStep?.label ?? "Evidence"}
                  </h2>
                  {selectedStep ? <StatusBadge status={selectedStep.status} /> : null}
                </div>
                <div className="mt-1 text-xs text-zinc-500">{selectedStep?.description}</div>
              </div>

              <div className="p-4">
                <div className="mb-3 flex flex-wrap gap-2">
                  {selectedStep?.controls.map((control) => (
                    <span
                      key={`${selectedStep.id}-${control.control}`}
                      className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-100"
                    >
                      {control.control} · {control.label}
                    </span>
                  ))}
                </div>

                {highlights.length ? (
                  <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {highlights.map((item) => (
                      <div key={item.key} className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
                        <div className="text-[11px] uppercase tracking-normal text-zinc-500">
                          {item.key}
                        </div>
                        <div className="mt-1 break-words font-mono text-xs leading-5 text-zinc-200">
                          {item.value}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                <pre className="h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-5 text-zinc-300">
                  {prettyJson(selectedStep?.evidence ?? { status: selectedStep?.status ?? "pending" })}
                </pre>
                {selectedStep?.error ? (
                  <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
                    {selectedStep.error}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-md border border-zinc-800 bg-[#111418]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">Runtime Logs</h2>
                  <div className="mt-1 text-xs text-zinc-500">
                    {logs ? `${logs.filters.length} filters · ${selectedLogMode}` : "not loaded"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => run?.id && loadLogs(run.id).catch(() => undefined)}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-cyan-400"
                >
                  refresh logs
                </button>
              </div>

              <div className="border-b border-zinc-800 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {logs?.containers.map((container) => (
                    <button
                      type="button"
                      key={container.name}
                      onClick={() => setSelectedLogName(container.name)}
                      className={`rounded-md border px-3 py-2 text-left ${
                        selectedLogName === container.name
                          ? "border-cyan-400 bg-cyan-400/10"
                          : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-zinc-100">
                          {logLabels[container.name] ?? container.name}
                        </span>
                        <span className={container.available ? "text-emerald-300" : "text-red-300"}>
                          <StatusIcon status={container.available ? "success" : "failed"} />
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {container.matchedLines.length
                          ? `${container.matchedLines.length} matched`
                          : "0 matched"}
                      </div>
                    </button>
                  )) ?? (
                    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-500">
                      No log sources
                    </div>
                  )}
                </div>
              </div>

              <div className="p-4">
                {selectedLogContainer?.error ? (
                  <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
                    {selectedLogContainer.error}
                  </div>
                ) : null}
                <pre className="h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-300">
                  {selectedLogLines.join("\n") || "No log lines"}
                </pre>
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
