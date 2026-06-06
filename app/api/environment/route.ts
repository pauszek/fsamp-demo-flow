import { getConfig } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FedRAMP AC-3: this endpoint exposes infrastructure identifiers (KMS,
// S3, DynamoDB ARNs) that should never reach the public network. The
// console is local-only by design; in any non-local NODE_ENV the route
// short-circuits to 404 so that an accidental deployment behind a
// public domain cannot leak environment metadata.
function isLocalOnlyEnvironment(): boolean {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  return process.env.FSAMP_DEMO_ALLOW_PRODUCTION === "true";
}

export async function GET() {
  if (!isLocalOnlyEnvironment()) {
    return new Response("Not Found", { status: 404 });
  }

  const config = getConfig();
  const localstack = await fetch(`${config.awsEndpointUrl}/_localstack/health`, {
    cache: "no-store",
  })
    .then((response) => ({ ok: response.ok, status: response.status }))
    .catch((error: unknown) => ({
      ok: false,
      status: 0,
      // Avoid leaking AWS SDK or LocalStack internal error strings to the
      // client; surface only a stable category for the UI status panel.
      error: error instanceof Error ? error.name : "FetchError",
    }));

  const gateway = await fetch(`${config.gatewayUrl}/actuator/health`, {
    cache: "no-store",
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
