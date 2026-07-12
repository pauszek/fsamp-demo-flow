import { getConfig } from "@/lib/server/config";
import { authorizeDemoRequest } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;

  const config = getConfig();
  const localstack = await fetch(`${config.awsEndpointUrl}/_localstack/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  })
    .then((response) => ({ ok: response.ok, status: response.status }))
    .catch((error: unknown) => ({
      ok: false,
      status: 0,
      // Avoid leaking AWS SDK or LocalStack internal error strings to the
      // client; surface only a stable category for the UI status panel.
      error: error instanceof Error ? error.name : "FetchError",
    }));

  const gatewayHealthUrl = new URL(
    config.gatewayHealthPath.replace(/^\/+/, ""),
    config.gatewayUrl.endsWith("/") ? config.gatewayUrl : `${config.gatewayUrl}/`,
  ).toString();
  const gateway = await fetch(gatewayHealthUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  })
    .then((response) => ({ ok: response.ok, status: response.status }))
    .catch((error: unknown) => ({
      ok: false,
      status: 0,
      error: error instanceof Error ? error.name : "FetchError",
    }));

  return Response.json({
    gateway,
    localstack,
    config: {
      gatewayUrl: config.gatewayUrl,
      gatewayUploadPath: config.gatewayUploadPath,
      gatewayHealthPath: config.gatewayHealthPath,
      awsEndpointUrl: config.awsEndpointUrl,
      awsRegion: config.awsRegion,
      s3BucketName: config.s3BucketName,
      metadataTableName: config.metadataTableName,
      outboxTableName: config.outboxTableName,
      idempotencyTableName: config.idempotencyTableName,
      directPublishAfterOutbox: config.directPublishAfterOutbox,
      runtimeMode: config.runtimeMode,
      sqsQueueUrl: config.sqsQueueUrl,
      processingDlqQueueUrl: config.processingDlqQueueUrl,
      snsTopicArn: config.snsTopicArn,
      fileEventsTopicArn: config.fileEventsTopicArn,
      processingEventsTopicArn: config.processingEventsTopicArn,
      processorLambdaName: config.processorLambdaName,
      outboxPublisherLambdaName: config.outboxPublisherLambdaName,
      kmsKeyId: config.kmsKeyId,
      dockerLogsEnabled: config.dockerLogsEnabled,
    },
  });
}
