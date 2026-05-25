import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DemoLogBundle, FlowRun } from "@/lib/flow/types";
import { getConfig } from "@/lib/server/config";

const execFileAsync = promisify(execFile);

const CONTAINERS = [
  "fsamp-e2e-gateway",
  "fsamp-e2e-processor",
  "fsamp-e2e-localstack",
];

function compactLines(output: string, limit = 80) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit);
}

function withUuidDashes(value?: string) {
  if (!value || value.includes("-") || value.length !== 32) return [];
  return [
    `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
      16,
      20,
    )}-${value.slice(20)}`,
  ];
}

export async function collectLogs(run: FlowRun): Promise<DemoLogBundle> {
  const filters = [
    run.fileId,
    run.correlationId,
    ...withUuidDashes(run.correlationId),
    run.directEvent?.eventId,
    run.uploadResponse?.filename,
    run.input.filename,
    run.objectKey,
    run.id,
  ].filter((value): value is string => Boolean(value));

  if (!getConfig().dockerLogsEnabled) {
    return {
      runId: run.id,
      filters,
      containers: CONTAINERS.map((name) => ({
        name,
        available: false,
        matchedLines: [],
        tail: [],
        error: "Docker log collection disabled.",
      })),
    };
  }

  const containers = await Promise.all(
    CONTAINERS.map(async (name) => {
      try {
        const { stdout, stderr } = await execFileAsync("docker", ["logs", "--tail", "260", name]);
        const lines = compactLines(`${stdout}\n${stderr}`, 220);
        const matchedLines = filters.length
          ? lines.filter((line) => filters.some((filter) => line.includes(filter)))
          : [];

        return {
          name,
          available: true,
          matchedLines: matchedLines.slice(-120),
          tail: lines.slice(-90),
        };
      } catch (error) {
        return {
          name,
          available: false,
          matchedLines: [],
          tail: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return {
    runId: run.id,
    filters,
    containers,
  };
}
