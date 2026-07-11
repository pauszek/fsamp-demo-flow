import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

import type { DemoLogBundle, FlowRun } from "@/lib/flow/types";
import { cloudWatchLogsClient } from "@/lib/server/aws";
import { getConfig } from "@/lib/server/config";
import { sanitizeDiagnostic } from "@/lib/server/security";

const execFileAsync = promisify(execFile);
const CONTAINERS = ["fsamp-e2e-gateway", "fsamp-e2e-processor", "fsamp-e2e-localstack"];

function withUuidDashes(value?: string) {
  if (!value || value.includes("-") || value.length !== 32) return [];
  return [
    `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
      16,
      20,
    )}-${value.slice(20)}`,
  ];
}

function logGroups() {
  const config = getConfig();
  return [
    `/aws/lambda/${config.outboxPublisherLambdaName}`,
    `/aws/lambda/${config.processorLambdaName}`,
    "/ecs/fsamp-local",
  ];
}

function matchingLines(lines: string[], filters: string[]) {
  if (!filters.length) return [];
  return lines
    .filter((line) => filters.some((filter) => line.includes(filter)))
    .slice(-120)
    .map((line) => sanitizeDiagnostic(line, 2_000));
}

async function cloudWatchLines(groupName: string, run: FlowRun) {
  const client = cloudWatchLogsClient();
  const lines: string[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 3; page += 1) {
    const response = await client.send(
      new FilterLogEventsCommand({
        logGroupName: groupName,
        startTime: Math.max(0, Date.parse(run.createdAt) - 60_000),
        endTime: Date.now() + 1_000,
        limit: 1_000,
        nextToken,
      }),
    );
    for (const event of response.events ?? []) {
      const timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : "no-timestamp";
      lines.push(`[${timestamp}] ${event.logStreamName ?? "stream"} ${event.message ?? ""}`);
    }
    if (!response.nextToken || response.nextToken === nextToken) break;
    nextToken = response.nextToken;
  }
  return lines;
}

async function collectCloudWatchLogs(
  run: FlowRun,
  filters: string[],
): Promise<DemoLogBundle> {
  const groups = await Promise.all(
    logGroups().map(async (name) => {
      try {
        const lines = await cloudWatchLines(name, run);
        return {
          name,
          available: true,
          matchedLines: matchingLines(lines, filters),
        };
      } catch (error) {
        return {
          name,
          available: false,
          matchedLines: [],
          error: sanitizeDiagnostic(error instanceof Error ? error.name : "LogQueryError"),
        };
      }
    }),
  );
  return { runId: run.id, filters, containers: groups };
}

export async function collectLogs(run: FlowRun): Promise<DemoLogBundle> {
  const config = getConfig();
  const filters = [
    run.fileId,
    run.correlationId,
    ...withUuidDashes(run.correlationId),
    run.requestId,
    run.idempotencyKey,
    run.directEvent?.eventId,
    run.directEvent?.messageId,
    run.objectKey,
    run.id,
  ].filter((value): value is string => Boolean(value));

  if (config.runtimeMode === "terraform-local") {
    return collectCloudWatchLogs(run, filters);
  }
  if (!config.dockerLogsEnabled) {
    return {
      runId: run.id,
      filters,
      containers: CONTAINERS.map((name) => ({
        name,
        available: false,
        matchedLines: [],
        error: "Docker log collection disabled",
      })),
    };
  }

  const containers = await Promise.all(
    CONTAINERS.map(async (name) => {
      try {
        const { stdout, stderr } = await execFileAsync(
          "docker",
          ["logs", "--since", run.createdAt, "--tail", "1000", name],
          { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 },
        );
        const lines = `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean);
        return {
          name,
          available: true,
          matchedLines: matchingLines(lines, filters),
        };
      } catch (error) {
        return {
          name,
          available: false,
          matchedLines: [],
          error: sanitizeDiagnostic(error instanceof Error ? error.name : "LogQueryError"),
        };
      }
    }),
  );
  return { runId: run.id, filters, containers };
}
