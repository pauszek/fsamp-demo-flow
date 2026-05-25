"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { FlowStep } from "@/lib/flow/types";
import { StatusIcon, statusClass } from "@/components/status";

type NodeData = {
  step: FlowStep;
  selected: boolean;
  order: number;
};

const laneLabels: Record<FlowStep["lane"], string> = {
  ingress: "Ingress",
  security: "Security",
  eventing: "Eventing",
  processing: "Processing",
  persistence: "Persistence",
};

export function FlowNode({ data }: NodeProps) {
  const { step, selected, order } = data as NodeData;

  return (
    <div
      className={`min-h-[136px] w-[236px] rounded-md border bg-zinc-950/95 p-3 shadow-lg shadow-black/20 transition ${
        selected ? "border-cyan-300 ring-2 ring-cyan-300/30" : statusClass(step.status)
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-zinc-400" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-normal text-zinc-500">
            <span>{String(order).padStart(2, "0")}</span>
            <span>{laneLabels[step.lane]}</span>
          </div>
          <div className="mt-1 truncate text-sm font-semibold leading-snug text-zinc-50">
            {step.shortLabel}
          </div>
        </div>
        <span className="mt-0.5 text-zinc-200">
          <StatusIcon status={step.status} />
        </span>
      </div>
      <div className="mt-2 line-clamp-2 min-h-10 text-xs leading-5 text-zinc-400">
        {step.component}
      </div>
      <div className="mt-2 text-[11px] uppercase tracking-normal text-zinc-500">
        {step.status}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-sm bg-zinc-800">
        <div
          className={`h-full ${
            step.status === "success"
              ? "bg-emerald-400"
              : step.status === "failed"
                ? "bg-red-400"
                : step.status === "running"
                  ? "bg-sky-400"
                  : step.status === "skipped"
                    ? "bg-zinc-500"
                    : "bg-zinc-700"
          }`}
          style={{
            width:
              step.status === "success" || step.status === "failed" || step.status === "skipped"
                ? "100%"
                : step.status === "running"
                  ? "58%"
                  : "18%",
          }}
        />
      </div>
      <Handle type="source" position={Position.Right} className="!bg-zinc-400" />
    </div>
  );
}
