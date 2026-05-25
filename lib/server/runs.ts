import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { nanoid } from "nanoid";

import { createInitialSteps } from "@/lib/flow/steps";
import type { FlowMode, FlowRun, FlowRunInput, RunListItem } from "@/lib/flow/types";

function runDir() {
  return path.join(process.cwd(), ".demo-runs");
}

function runPath(runId: string) {
  return path.join(runDir(), `${runId}.json`);
}

export async function createRun(mode: FlowMode, input: FlowRunInput): Promise<FlowRun> {
  const now = new Date().toISOString();
  const run: FlowRun = {
    id: `run_${nanoid(12)}`,
    mode,
    status: "running",
    createdAt: now,
    updatedAt: now,
    input,
    steps: createInitialSteps(),
    errors: [],
    summary: {
      completedSteps: 0,
      totalSteps: createInitialSteps().length,
    },
  };

  await saveRun(run);
  return run;
}

export async function saveRun(run: FlowRun): Promise<FlowRun> {
  const nextRun = {
    ...run,
    updatedAt: new Date().toISOString(),
  };

  await mkdir(runDir(), { recursive: true });
  await writeFile(runPath(nextRun.id), JSON.stringify(nextRun, null, 2));
  return nextRun;
}

export async function getRun(runId: string): Promise<FlowRun | undefined> {
  try {
    return JSON.parse(await readFile(runPath(runId), "utf8")) as FlowRun;
  } catch {
    return undefined;
  }
}

export async function listRuns(): Promise<RunListItem[]> {
  await mkdir(runDir(), { recursive: true });
  const files = await readdir(runDir());
  const runs = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return JSON.parse(await readFile(path.join(runDir(), file), "utf8")) as FlowRun;
        } catch {
          return undefined;
        }
      }),
  );

  return runs
    .filter((run): run is FlowRun => Boolean(run))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((run) => ({
      id: run.id,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      fileId: run.fileId,
      correlationId: run.correlationId,
      filename: run.input.filename,
    }));
}

export async function getLatestRun(): Promise<FlowRun | undefined> {
  const [latest] = await listRuns();
  return latest ? getRun(latest.id) : undefined;
}
