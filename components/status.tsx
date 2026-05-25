import { AlertTriangle, CheckCircle2, Circle, Clock3, MinusCircle } from "lucide-react";

import type { RunStatus, StepStatus } from "@/lib/flow/types";

export function statusClass(status: StepStatus | RunStatus) {
  switch (status) {
    case "success":
      return "border-emerald-500/40 bg-emerald-500/12 text-emerald-200";
    case "failed":
      return "border-red-500/50 bg-red-500/12 text-red-200";
    case "running":
      return "border-sky-500/50 bg-sky-500/12 text-sky-200";
    case "partial":
      return "border-amber-500/50 bg-amber-500/12 text-amber-200";
    case "skipped":
      return "border-zinc-600 bg-zinc-800 text-zinc-300";
    case "idle":
    case "pending":
    default:
      return "border-zinc-700 bg-zinc-900 text-zinc-400";
  }
}

export function StatusIcon({ status }: { status: StepStatus | RunStatus }) {
  if (status === "success") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "failed") return <AlertTriangle className="h-4 w-4" />;
  if (status === "running") return <Clock3 className="h-4 w-4" />;
  if (status === "skipped") return <MinusCircle className="h-4 w-4" />;
  return <Circle className="h-4 w-4" />;
}

export function StatusBadge({ status }: { status: StepStatus | RunStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium uppercase tracking-normal ${statusClass(
        status,
      )}`}
    >
      <StatusIcon status={status} />
      {status}
    </span>
  );
}
