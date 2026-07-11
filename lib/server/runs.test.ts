import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRun, getRun, listRuns } from "@/lib/server/runs";

const directory = path.join(process.cwd(), ".demo-runs");
const input = { filename: "sample.txt", contentType: "text/plain", sizeBytes: 4 };

describe("bounded run storage", () => {
  beforeEach(async () => {
    vi.stubEnv("FSAMP_DEMO_MAX_STORED_RUNS", "2");
    await rm(directory, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects traversal identifiers", async () => {
    await expect(getRun("../../etc/passwd")).resolves.toBeUndefined();
  });

  it("retains only the configured number of newest runs", async () => {
    await createRun("upload", input);
    await createRun("upload", input);
    await createRun("event", input);
    await expect(listRuns()).resolves.toHaveLength(2);
  });
});
