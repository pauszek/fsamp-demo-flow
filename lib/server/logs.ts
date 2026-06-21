import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

import type { DemoLogBundle, FlowRun } from "@/lib/flow/types";
import { cloudWatchLogsClient } from "@/lib/server/aws";
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

function parityLogGroups() {
  const config = getConfig();
  return [
    `/aws/lambda/${config.outboxPublisherLambdaName}`,
    `/aws/lambda/${config.processorLambdaName}`,
    "/ecs/fsamp-local",
  ];
}

async function collectCloudWatchLogs(runId: string, filters: string[]): Promise<DemoLogBundle> {
  const client = cloudWatchLogsClient();
  const groups = await Promise.all(
    parityLogGroups().map(async (name) => {
      try {
        const response = await client.send(
          new FilterLogEventsCommand({
            logGroupName: name,
            limit: 240,
          }),
        );
        const lines = (response.events ?? [])
          .map((event) => {
            const timestamp = event.timestamp
              ? new Date(event.timestamp).toISOString()
              : "no-timestamp";
            return `[${timestamp}] ${event.logStreamName ?? "stream"} ${event.message ?? ""}`;
          })
          .filter(Boolean);
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
    runId,
    filters,
    containers: groups,
  };
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
    run.uploadResponse?.filename,
    run.input.filename,
    run.objectKey,
    run.id,
  ].filter((value): value is string => Boolean(value));

  if (config.runtimeMode === "terraform-local") {
    return collectCloudWatchLogs(run.id, filters);
  }

  if (!config.dockerLogsEnabled) {
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
