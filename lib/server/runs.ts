import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { nanoid } from "nanoid";

import { createInitialSteps } from "@/lib/flow/steps";
import type { FlowMode, FlowRun, FlowRunInput, RunListItem } from "@/lib/flow/types";
import { getConfig } from "@/lib/server/config";

const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{12}$/;

function runDir() {
  return path.join(process.cwd(), ".demo-runs");
}

function runPath(runId: string) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Invalid run identifier");
  }
  return path.join(runDir(), `${runId}.json`);
}

async function removeExpiredRuns() {
  const config = getConfig();
  await mkdir(runDir(), { recursive: true, mode: 0o700 });
  const filenames = (await readdir(runDir())).filter(
    (filename) => RUN_ID_PATTERN.test(filename.replace(/\.json$/, "")) && filename.endsWith(".json"),
  );
  const cutoff = Date.now() - config.runRetentionHours * 60 * 60 * 1000;
  const entries = await Promise.all(
    filenames.map(async (filename) => {
      const filePath = path.join(runDir(), filename);
      try {
        const info = await lstat(filePath);
        if (!info.isFile()) return { filename, createdAt: 0, remove: true };
        const run = JSON.parse(await readFile(filePath, "utf8")) as FlowRun;
        const createdAt = Date.parse(run.createdAt);
        return {
          filename,
          createdAt: Number.isFinite(createdAt) ? createdAt : info.mtimeMs,
          remove: !Number.isFinite(createdAt) || createdAt < cutoff,
        };
      } catch {
        return { filename, createdAt: 0, remove: true };
      }
    }),
  );

  const retained = entries
    .filter((entry) => !entry.remove)
    .sort((left, right) => right.createdAt - left.createdAt);
  const remove = [
    ...entries.filter((entry) => entry.remove),
    ...retained.slice(config.maxStoredRuns),
  ];
  await Promise.all(
    remove.map((entry) => unlink(path.join(runDir(), entry.filename)).catch(() => undefined)),
  );
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

  await mkdir(runDir(), { recursive: true, mode: 0o700 });
  const destination = runPath(nextRun.id);
  const temporary = path.join(runDir(), `.${nextRun.id}.${nanoid(8)}.tmp`);
  await writeFile(temporary, JSON.stringify(nextRun, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, destination);
  await removeExpiredRuns();
  return nextRun;
}

export async function getRun(runId: string): Promise<FlowRun | undefined> {
  try {
    const filePath = runPath(runId);
    const info = await lstat(filePath);
    if (!info.isFile()) return undefined;
    return JSON.parse(await readFile(filePath, "utf8")) as FlowRun;
  } catch {
    return undefined;
  }
}

export async function listRuns(): Promise<RunListItem[]> {
  await removeExpiredRuns();
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
