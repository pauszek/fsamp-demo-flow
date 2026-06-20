export type DemoConfig = {
  gatewayUrl: string;
  gatewayUploadPath: string;
  gatewayHealthPath: string;
  awsEndpointUrl: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  s3BucketName: string;
  metadataTableName: string;
  outboxTableName: string;
  idempotencyTableName: string;
  directPublishAfterOutbox: boolean;
  runtimeMode: string;
  sqsQueueName: string;
  sqsQueueUrl: string;
  processingDlqQueueName: string;
  processingDlqQueueUrl: string;
  snsTopicArn: string;
  fileEventsTopicArn: string;
  processingEventsTopicArn: string;
  processorLambdaName: string;
  outboxPublisherLambdaName: string;
  kmsKeyId: string;
  testUser: string;
  testPassword: string;
  dockerLogsEnabled: boolean;
};

export function getConfig(): DemoConfig {
  const awsEndpointUrl = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
  const awsRegion = process.env.AWS_REGION ?? "us-west-2";
  const sqsQueueName = process.env.SQS_QUEUE_NAME ?? "fsamp-local-file-processing";
  const processingDlqQueueName =
    process.env.SQS_PROCESSING_DLQ_NAME ?? "fsamp-local-processing-dlq";

  return {
    gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:8080",
    gatewayUploadPath: process.env.GATEWAY_UPLOAD_PATH ?? "/files/upload",
    gatewayHealthPath: process.env.GATEWAY_HEALTH_PATH ?? "/health",
    awsEndpointUrl,
    awsRegion,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    s3BucketName: process.env.S3_BUCKET_NAME ?? "fsamp-local-files",
    metadataTableName: process.env.DYNAMODB_TABLE_NAME ?? "fsamp-local-file-metadata",
    outboxTableName: process.env.OUTBOX_TABLE_NAME ?? "fsamp-local-outbox",
    idempotencyTableName:
      process.env.DYNAMODB_IDEMPOTENCY_TABLE_NAME ?? "fsamp-local-idempotency-keys",
    sqsQueueName,
    sqsQueueUrl:
      process.env.SQS_QUEUE_URL ??
      `${awsEndpointUrl}/000000000000/${sqsQueueName}`,
    processingDlqQueueName,
    processingDlqQueueUrl:
      process.env.SQS_PROCESSING_DLQ_URL ??
      `${awsEndpointUrl}/000000000000/${processingDlqQueueName}`,
    snsTopicArn:
      process.env.SNS_TOPIC_ARN ??
      `arn:aws:sns:${awsRegion}:000000000000:fsamp-local-file-events`,
    fileEventsTopicArn:
      process.env.FILE_EVENTS_TOPIC_ARN ??
      process.env.SNS_TOPIC_ARN ??
      `arn:aws:sns:${awsRegion}:000000000000:fsamp-local-file-events`,
    processingEventsTopicArn:
      process.env.PROCESSING_EVENTS_TOPIC_ARN ??
      `arn:aws:sns:${awsRegion}:000000000000:fsamp-local-processing-events`,
    processorLambdaName: process.env.PROCESSOR_LAMBDA_NAME ?? "fsamp-local-processor",
    outboxPublisherLambdaName:
      process.env.OUTBOX_PUBLISHER_LAMBDA_NAME ?? "fsamp-local-outbox-publisher",
    kmsKeyId: process.env.KMS_KEY_ID ?? "alias/fsamp-local-master-key",
    testUser: process.env.TEST_USER ?? "e2e-test-user",
    testPassword: process.env.TEST_PASSWORD ?? "E2eTestPass123!",
    directPublishAfterOutbox: process.env.DIRECT_PUBLISH_AFTER_OUTBOX === "true",
    runtimeMode: process.env.FSAMP_DEMO_RUNTIME ?? "terraform-local",
    dockerLogsEnabled:
      process.env.FSAMP_DEMO_DOCKER_LOGS === "true" ||
      process.env.FSAMP_DEMO_RUNTIME === "compose",
  };
}
