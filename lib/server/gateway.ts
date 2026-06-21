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
  const correlationId = randomUUID().replaceAll("-", "");
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
  });

  let uploadResponse: UploadResponse = {};
  const responseText = await response.text();
  try {
    uploadResponse = JSON.parse(responseText) as UploadResponse;
  } catch {
    uploadResponse = { raw: responseText };
  }

  if (!response.ok) {
    const details = responseText ? `: ${responseText.slice(0, 500)}` : "";
    throw new Error(`Gateway upload failed: ${response.status} ${response.statusText}${details}`);
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
