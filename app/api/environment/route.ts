import { getConfig } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = getConfig();
  const localstack = await fetch(`${config.awsEndpointUrl}/_localstack/health`, {
    cache: "no-store",
  })
    .then((response) => ({ ok: response.ok, status: response.status }))
    .catch((error: unknown) => ({
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    }));

  const gateway = await fetch(`${config.gatewayUrl}/actuator/health`, {
    cache: "no-store",
  })
    .then((response) => ({ ok: response.ok, status: response.status }))
    .catch((error: unknown) => ({
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    }));

  return Response.json({
    gateway,
    localstack,
    config: {
      gatewayUrl: config.gatewayUrl,
      awsEndpointUrl: config.awsEndpointUrl,
      awsRegion: config.awsRegion,
      s3BucketName: config.s3BucketName,
      metadataTableName: config.metadataTableName,
      outboxTableName: config.outboxTableName,
      sqsQueueUrl: config.sqsQueueUrl,
      snsTopicArn: config.snsTopicArn,
      kmsKeyId: config.kmsKeyId,
      dockerLogsEnabled: config.dockerLogsEnabled,
    },
  });
}
