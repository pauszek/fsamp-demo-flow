import { NextRequest } from "next/server";

import { collectEvidence } from "@/lib/server/evidence";
import { publishDirectFileEvent } from "@/lib/server/direct-event";
import { uploadThroughGateway } from "@/lib/server/gateway";
import { createRun, getLatestRun, listRuns, saveRun } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function defaultDemoFile() {
  const content = `FSAMP demo flow\nTimestamp: ${new Date().toISOString()}\n`;
  return new File([content], `fsamp-demo-${Date.now()}.txt`, {
    type: "text/plain",
  });
}

export async function GET() {
  const [runs, latest] = await Promise.all([listRuns(), getLatestRun()]);
  return Response.json({ runs, latest });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const mode = form.get("mode") === "event" ? "event" : "upload";
  const fileEntry = form.get("file");
  const file = fileEntry instanceof File ? fileEntry : defaultDemoFile();

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
      errors: [
        ...run.errors,
        error instanceof Error ? error.message : String(error),
      ],
    };
  }

  run = await saveRun(run);
  return Response.json(run, { status: run.status === "failed" ? 500 : 201 });
}
