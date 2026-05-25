export type DemoConfig = {
  gatewayUrl: string;
  awsEndpointUrl: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  s3BucketName: string;
  metadataTableName: string;
  outboxTableName: string;
  sqsQueueName: string;
  sqsQueueUrl: string;
  snsTopicArn: string;
  kmsKeyId: string;
  testUser: string;
  testPassword: string;
  dockerLogsEnabled: boolean;
};

export function getConfig(): DemoConfig {
  const awsEndpointUrl = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
  const awsRegion = process.env.AWS_REGION ?? "us-west-2";
  const sqsQueueName = process.env.SQS_QUEUE_NAME ?? "fsamp-local-processing-queue";

  return {
    gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:8080",
    awsEndpointUrl,
    awsRegion,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    s3BucketName: process.env.S3_BUCKET_NAME ?? "fsamp-local-files",
    metadataTableName: process.env.DYNAMODB_TABLE_NAME ?? "fsamp-local-file-metadata",
    outboxTableName: process.env.OUTBOX_TABLE_NAME ?? "fsamp-local-outbox",
    sqsQueueName,
    sqsQueueUrl:
      process.env.SQS_QUEUE_URL ??
      `${awsEndpointUrl}/000000000000/${sqsQueueName}`,
    snsTopicArn:
      process.env.SNS_TOPIC_ARN ??
      `arn:aws:sns:${awsRegion}:000000000000:fsamp-local-file-events`,
    kmsKeyId: process.env.KMS_KEY_ID ?? "alias/fsamp-local-master-key",
    testUser: process.env.TEST_USER ?? "e2e-test-user",
    testPassword: process.env.TEST_PASSWORD ?? "E2eTestPass123!",
    dockerLogsEnabled: process.env.FSAMP_DEMO_DOCKER_LOGS !== "false",
  };
}
