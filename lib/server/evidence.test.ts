import { describe, expect, it } from "vitest";

import { createInitialSteps } from "@/lib/flow/steps";
import type { FlowRun } from "@/lib/flow/types";
import { validateEvent } from "@/lib/server/evidence";

const run: FlowRun = {
  id: "run_abcdefghijkl",
  mode: "upload",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  input: { filename: "sample.txt", contentType: "text/plain", sizeBytes: 4 },
  fileId: "67aa1d0e-d087-4d2a-b69b-924cc09d83aa",
  correlationId: "55ffaf8c-05c1-4698-9985-e186940bfbc9",
  objectKey: "uploads/sample.txt",
  bucketName: "fsamp-local-files",
  steps: createInitialSteps(),
  errors: [],
  summary: { completedSteps: 0, totalSteps: 15 },
};

function completedEvent() {
  return {
    schemaVersion: "1.2.0",
    fileId: run.fileId,
    eventId: "ea4b0fc8-beb6-5078-9b90-8d32a3bd74bf",
    correlationId: run.correlationId,
    timestamp: "2026-01-01T00:00:01.000Z",
    source: "fsamp-processor",
    eventType: "ANALYSIS_COMPLETED",
    fileMetadata: {
      originalFilename: run.input.filename,
      fileSizeBytes: run.input.sizeBytes,
      mimeType: run.input.contentType,
      checksumSHA256: "a".repeat(64),
    },
    storageLocation: {
      bucketName: run.bucketName,
      objectKey: run.objectKey,
      region: "us-west-2",
    },
    securityContext: {
      isEncrypted: true,
      encryptionAlgorithm: "AES/GCM/NoPadding",
      kmsKeyId: "arn:aws:kms:us-west-2:000000000000:key/12345678-1234-1234-1234-123456789012",
    },
    processingResult: {
      isSafe: true,
      findings: [],
      processedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

describe("event evidence contract", () => {
  it("accepts a canonical processor result for the same run", () => {
    expect(
      validateEvent(completedEvent(), run, ["ANALYSIS_COMPLETED"], "fsamp-processor"),
    ).toBe(true);
  });

  it("rejects stale schemas, wrong producers, and mismatched files", () => {
    expect(
      validateEvent(
        { ...completedEvent(), schemaVersion: "1.1.2" },
        run,
        ["ANALYSIS_COMPLETED"],
        "fsamp-processor",
      ),
    ).toBe(false);
    expect(
      validateEvent(
        { ...completedEvent(), source: "fsamp-gateway" },
        run,
        ["ANALYSIS_COMPLETED"],
        "fsamp-processor",
      ),
    ).toBe(false);
    expect(
      validateEvent(
        { ...completedEvent(), fileId: "0dd6ae40-b228-4792-8ce7-4e6e6a1d6938" },
        run,
        ["ANALYSIS_COMPLETED"],
        "fsamp-processor",
      ),
    ).toBe(false);
  });
});
