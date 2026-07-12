import { NextRequest } from "next/server";

import { collectEvidence } from "@/lib/server/evidence";
import { publishDirectFileEvent } from "@/lib/server/direct-event";
import { uploadThroughGateway } from "@/lib/server/gateway";
import { getConfig } from "@/lib/server/config";
import { createRun, getLatestRun, listRuns, saveRun } from "@/lib/server/runs";
import { authorizeDemoRequest, sanitizeDiagnostic } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function defaultDemoFile() {
  const content = `FSAMP demo flow\nTimestamp: ${new Date().toISOString()}\n`;
  return new File([content], `fsamp-demo-${Date.now()}.txt`, {
    type: "text/plain",
  });
}

export async function GET(request: NextRequest) {
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;
  const [runs, latest] = await Promise.all([listRuns(), getLatestRun()]);
  return Response.json({ runs, latest });
}

function safeFilename(value: string) {
  const basename = value.split(/[\\/]/).at(-1) || "demo-file.bin";
  const normalized = basename.normalize("NFKC").replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return (normalized || "demo-file.bin").slice(0, 180);
}

export async function POST(request: NextRequest) {
  const denied = authorizeDemoRequest(request, { mutation: true });
  if (denied) return denied;

  const config = getConfig();
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return Response.json({ error: "Content-Length is required" }, { status: 411 });
  }
  if (contentLength > config.maxUploadBytes + 1024 * 1024) {
    return Response.json({ error: "Upload exceeds the configured limit" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Invalid multipart request" }, { status: 400 });
  }
  const mode = form.get("mode") === "event" ? "event" : "upload";
  const fileEntry = form.get("file");
  const sourceFile = fileEntry instanceof File ? fileEntry : defaultDemoFile();
  if (sourceFile.size <= 0 || sourceFile.size > config.maxUploadBytes) {
    return Response.json({ error: "File size is outside the configured limit" }, { status: 413 });
  }
  const file = new File([sourceFile], safeFilename(sourceFile.name), {
    type: (sourceFile.type || "application/octet-stream").slice(0, 120),
  });

  let run = await createRun(mode, {
    filename: file.name,
    contentType: file.type || "text/plain",
    sizeBytes: file.size,
  });

  try {
    if (mode === "upload") {
      run = await uploadThroughGateway(run, file);
    } else {
      const directEvent = await publishDirectFileEvent(file);
      run = {
        ...run,
        fileId: directEvent.fileId,
        correlationId: directEvent.correlationId,
        objectKey: directEvent.objectKey,
        bucketName: directEvent.bucketName,
        directEvent,
      };
    }

    run = await collectEvidence(run);
  } catch (error) {
    run = {
      ...run,
      status: "failed",
      errors: [...run.errors, sanitizeDiagnostic(error)],
    };
  }

  run = await saveRun(run);
  return Response.json(run, { status: run.status === "failed" ? 500 : 201 });
}
