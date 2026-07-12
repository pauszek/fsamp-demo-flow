import { randomUUID } from "node:crypto";

import type { FlowRun, UploadResponse } from "@/lib/flow/types";
import { getConfig } from "@/lib/server/config";
import { getAccessToken } from "@/lib/server/cognito";

function joinGatewayUrl(baseUrl: string, path: string) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBase).toString();
}

export async function uploadThroughGateway(run: FlowRun, file: File): Promise<FlowRun> {
  const token = await getAccessToken();
  const config = getConfig();
  const correlationId = randomUUID();
  const idempotencyKey = randomUUID();
  const requestId = randomUUID();

  const body = new FormData();
  body.append("file", file, file.name);
  body.append(
    "metadata",
    JSON.stringify({
      source: "fsamp-demo-flow",
      runId: run.id,
    }),
  );

  const uploadUrl = joinGatewayUrl(config.gatewayUrl, config.gatewayUploadPath);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Correlation-ID": correlationId,
      "X-Request-ID": requestId,
      "X-Idempotency-Key": idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });

  let uploadResponse: UploadResponse = {};
  const responseText = await response.text();
  try {
    uploadResponse = JSON.parse(responseText) as UploadResponse;
  } catch {
    uploadResponse = {};
  }

  if (!response.ok) {
    throw new Error(`Gateway upload failed with HTTP ${response.status}`);
  }

  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !uploadResponse.fileId ||
    !uuidV4.test(uploadResponse.fileId) ||
    !uploadResponse.correlationId ||
    !uuidV4.test(uploadResponse.correlationId) ||
    uploadResponse.status !== "UPLOADED" ||
    !/^[0-9a-f]{64}$/i.test(uploadResponse.checksum ?? "")
  ) {
    throw new Error("Gateway returned an invalid upload contract");
  }

  return {
    ...run,
    fileId: uploadResponse.fileId ?? run.fileId,
    correlationId: uploadResponse.correlationId ?? correlationId,
    requestId,
    idempotencyKey,
    bucketName: config.s3BucketName,
    uploadResponse: {
      ...uploadResponse,
      uploadUrl,
    },
  };
}
