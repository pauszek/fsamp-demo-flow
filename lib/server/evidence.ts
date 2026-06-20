import {
  DescribeTableCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { DescribeKeyCommand } from "@aws-sdk/client-kms";
import {
  GetFunctionCommand,
  ListEventSourceMappingsCommand,
} from "@aws-sdk/client-lambda";
import {
  GetBucketEncryptionCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
} from "@aws-sdk/client-sns";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import type { FlowEvidence, FlowRun, StepId, StepStatus } from "@/lib/flow/types";
import { createInitialSteps, terminalStepIdsForMode } from "@/lib/flow/steps";
import {
  dynamoClient,
  kmsClient,
  lambdaClient,
  s3Client,
  snsClient,
  sqsClient,
} from "@/lib/server/aws";
import { getConfig } from "@/lib/server/config";
import { discoverCognitoIds } from "@/lib/server/cognito";

type StepPatch = {
  status: StepStatus;
  evidence?: FlowEvidence;
  error?: string;
};

function patchStep(run: FlowRun, stepId: StepId, patch: StepPatch) {
  const now = new Date().toISOString();
  run.steps = run.steps.map((step) => {
    if (step.id !== stepId) return step;

    return {
      ...step,
      ...patch,
      startedAt: step.startedAt ?? now,
      completedAt:
        patch.status === "success" || patch.status === "failed" || patch.status === "skipped"
          ? now
          : step.completedAt,
    };
  });
}

function normalizeRunSteps(run: FlowRun) {
  const storedSteps = new Map(run.steps.map((step) => [step.id, step]));
  return createInitialSteps().map((definition) => {
    const stored = storedSteps.get(definition.id);
    if (!stored) return definition;

    return {
      ...definition,
      status: stored.status,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
      evidence: stored.evidence,
      error: stored.error,
    };
  });
}

function failStep(run: FlowRun, stepId: StepId, error: unknown) {
  patchStep(run, stepId, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
}

function skipStepsForMode(run: FlowRun) {
  for (const stepId of terminalStepIdsForMode(run.mode)) {
    patchStep(run, stepId, {
      status: "skipped",
      evidence: { reason: "Direct event mode bypasses gateway upload path." },
    });
  }
}

function asNativeItem(item?: Record<string, AttributeValue>) {
  return item ? unmarshall(item) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getLocalStackHealth() {
  const config = getConfig();
  const response = await fetch(`${config.awsEndpointUrl}/_localstack/health`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`LocalStack health returned ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function queryByPk(tableName: string, pk: string, limit = 10) {
  const response = await dynamoClient().send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: pk },
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return (response.Items ?? []).map(asNativeItem).filter(Boolean) as Record<string, unknown>[];
}

function findMatchingOutbox(items: Record<string, unknown>[], fileId?: string) {
  if (!fileId) return undefined;
  return items.find((item) => {
    const aggregateId = String(item.aggregateId ?? "");
    const payload = isRecord(item.payload)
      ? JSON.stringify(item.payload)
      : String(item.payload ?? "");
    return aggregateId === fileId || payload.includes(fileId);
  });
}

async function getLambdaEvidence(functionName: string, eventSourceArn?: string) {
  const client = lambdaClient();
  const [fn, mappings] = await Promise.all([
    client.send(new GetFunctionCommand({ FunctionName: functionName })),
    client.send(
      new ListEventSourceMappingsCommand({
        FunctionName: functionName,
        EventSourceArn: eventSourceArn,
      }),
    ),
  ]);

  return {
    functionName,
    functionArn: fn.Configuration?.FunctionArn,
    packageType: fn.Configuration?.PackageType,
    state: fn.Configuration?.State,
    lastUpdateStatus: fn.Configuration?.LastUpdateStatus,
    imageUri: fn.Code?.ImageUri,
    eventSourceMappings: (mappings.EventSourceMappings ?? []).map((mapping) => ({
      uuid: mapping.UUID,
      state: mapping.State,
      eventSourceArn: mapping.EventSourceArn,
      functionArn: mapping.FunctionArn,
      batchSize: mapping.BatchSize,
      lastProcessingResult: mapping.LastProcessingResult,
    })),
  };
}

async function getBestEffortLambdaEvidence(functionName: string, eventSourceArn?: string) {
  return getLambdaEvidence(functionName, eventSourceArn).catch((error: unknown) => ({
    functionName,
    eventSourceArn,
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function observeLocalStack(run: FlowRun) {
  const config = getConfig();
  const health = await getLocalStackHealth();
  const key = await kmsClient().send(new DescribeKeyCommand({ KeyId: config.kmsKeyId }));

  patchStep(run, "localstack", {
    status: "success",
    evidence: {
      endpoint: config.awsEndpointUrl,
      region: config.awsRegion,
      services: health.services,
      activeEvidenceServices: [
        "s3",
        "dynamodb",
        "sns",
        "sqs",
        "kms",
        "cognito-idp",
        "lambda",
        "ecr",
        "events",
        "cloudwatch",
        "logs",
      ],
      optionalAuditServices: ["cloudtrail", "guardduty", "config"],
      kmsKeyState: key.KeyMetadata?.KeyState,
      kmsKeyArn: key.KeyMetadata?.Arn,
    },
  });
}

async function observeCognito(run: FlowRun) {
  if (run.mode === "event") return;
  const ids = await discoverCognitoIds();
  patchStep(run, "cognito", {
    status: "success",
    evidence: {
      userPoolId: ids.userPoolId,
      clientId: ids.clientId,
      authFlow: "ADMIN_NO_SRP_AUTH",
    },
  });
}

async function observeUpload(run: FlowRun) {
  if (run.mode === "event") return;
  if (!run.uploadResponse) {
    patchStep(run, "gateway-upload", { status: "running" });
    return;
  }

  patchStep(run, "gateway-upload", {
    status: "success",
    evidence: {
      gatewayUrl: getConfig().gatewayUrl,
      fileId: run.fileId,
      correlationId: run.correlationId,
      requestId: run.requestId,
      idempotencyKey: run.idempotencyKey,
      responseStatus: run.uploadResponse.status,
      message: run.uploadResponse.message,
    },
  });

  patchStep(run, "gateway-validation", {
    status: run.uploadResponse.checksum ? "success" : "running",
    evidence: {
      filename: run.uploadResponse.filename,
      mimeType: run.uploadResponse.mimeType,
      sizeBytes: run.uploadResponse.sizeBytes,
      checksumSha256: run.uploadResponse.checksum,
      statusDescription: run.uploadResponse.statusDescription,
    },
  });
}

async function observeIdempotency(run: FlowRun) {
  if (run.mode === "event") return;
  if (!run.idempotencyKey) {
    patchStep(run, "idempotency", {
      status: "running",
      evidence: { reason: "Gateway upload has not produced an idempotency key yet." },
    });
    return;
  }

  const config = getConfig();
  const response = await dynamoClient().send(
    new ScanCommand({
      TableName: config.idempotencyTableName,
      FilterExpression: "idempotencyKey = :key",
      ExpressionAttributeValues: {
        ":key": { S: run.idempotencyKey },
      },
      Limit: 5,
    }),
  );

  const records = (response.Items ?? []).map(asNativeItem).filter(Boolean) as Record<
    string,
    unknown
  >[];

  patchStep(run, "idempotency", {
    status: records.length ? "success" : "running",
    evidence: {
      tableName: config.idempotencyTableName,
      idempotencyKey: run.idempotencyKey,
      requestId: run.requestId,
      record: records[0] ?? "not found yet",
      recordsFound: records.length,
    },
  });
}

async function observeS3(run: FlowRun) {
  const config = getConfig();
  let objectKey = run.objectKey ?? run.directEvent?.objectKey;

  if (!objectKey && run.fileId) {
    const listed = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: config.s3BucketName,
        MaxKeys: 100,
      }),
    );
    objectKey = listed.Contents?.find((item) => item.Key?.includes(run.fileId ?? ""))?.Key;
  }

  if (!objectKey) {
    patchStep(run, "s3-store", {
      status: "running",
      evidence: { bucketName: config.s3BucketName, fileId: run.fileId },
    });
    return;
  }

  const head = await s3Client().send(
    new HeadObjectCommand({
      Bucket: config.s3BucketName,
      Key: objectKey,
    }),
  );
  const bucketEncryption = await s3Client()
    .send(new GetBucketEncryptionCommand({ Bucket: config.s3BucketName }))
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));

  run.objectKey = objectKey;
  run.bucketName = config.s3BucketName;

  patchStep(run, "s3-store", {
    status: "success",
    evidence: {
      bucketName: config.s3BucketName,
      objectKey,
      contentType: head.ContentType,
      contentLength: head.ContentLength,
      etag: head.ETag,
      serverSideEncryption: head.ServerSideEncryption,
      sseKmsKeyId: head.SSEKMSKeyId,
      metadata: head.Metadata,
      bucketEncryption,
    },
  });
}

async function observeOutbox(run: FlowRun) {
  if (!run.fileId) return;
  const config = getConfig();
  const table = await dynamoClient()
    .send(new DescribeTableCommand({ TableName: config.outboxTableName }))
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));

  if (run.mode === "upload") {
    const gatewayOutbox = await queryByPk(config.outboxTableName, "OUTBOX#FileUpload", 25);
    const event = findMatchingOutbox(gatewayOutbox, run.fileId);
    const status = String(event?.status ?? "");
    const streamArn = "Table" in table ? table.Table?.LatestStreamArn : undefined;
    const streamEnabled = "Table" in table ? Boolean(table.Table?.LatestStreamArn) : undefined;
    const localFallback = config.directPublishAfterOutbox;
    const awsPublisherObserved =
      status === "PUBLISHED" ||
      status === "PUBLISHING" ||
      Boolean(event?.publishedAt);
    const publishPath = localFallback
      ? "local gateway direct-publish-after-outbox fallback"
      : "DynamoDB Streams -> outbox-publisher Lambda -> SNS";
    const outboxPublisherLambda = await getBestEffortLambdaEvidence(
      config.outboxPublisherLambdaName,
      streamArn,
    );

    patchStep(run, "gateway-outbox", {
      status: event ? "success" : "running",
      evidence: {
        tableName: config.outboxTableName,
        searchedPk: "OUTBOX#FileUpload",
        streamEnabled,
        latestStreamArn: streamArn,
        event: event ?? "not found yet",
      },
    });

    patchStep(run, "outbox-publish", {
      status: event && (awsPublisherObserved || localFallback) ? "success" : "running",
      evidence: {
        tableName: config.outboxTableName,
        streamEnabled,
        latestStreamArn: streamArn,
        outboxStatus: status || "not found yet",
        publishPath,
        runtimeMode: config.runtimeMode,
        directPublishAfterOutbox: config.directPublishAfterOutbox,
        localParityMode: !localFallback,
        awsProductionPath: "DynamoDB Streams -> outbox-publisher Lambda -> SNS",
        fileEventsTopicArn: config.fileEventsTopicArn,
        processingEventsTopicArn: config.processingEventsTopicArn,
        outboxPublisherLambdaName: config.outboxPublisherLambdaName,
        outboxPublisherLambda,
        awsPublisherObserved,
        localDirectPublishFallback: localFallback,
        eventId: event?.eventId,
        eventType: event?.eventType,
        publishedAt: event?.publishedAt,
      },
    });
  }

  const processingOutbox = await queryByPk(config.outboxTableName, "OUTBOX#FileProcessing", 25);
  const resultEvent = findMatchingOutbox(processingOutbox, run.fileId);

  patchStep(run, "result-outbox", {
    status: resultEvent ? "success" : "running",
    evidence: {
      tableName: config.outboxTableName,
      searchedPk: "OUTBOX#FileProcessing",
      processingEventsTopicArn: config.processingEventsTopicArn,
      event: resultEvent ?? "not found yet",
    },
  });
}

async function observeMessaging(run: FlowRun) {
  const config = getConfig();
  const queue = await sqsClient().send(
    new GetQueueAttributesCommand({
      QueueUrl: config.sqsQueueUrl,
      AttributeNames: [
        "QueueArn",
        "KmsMasterKeyId",
        "RedrivePolicy",
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );
  const topic = await snsClient().send(
    new GetTopicAttributesCommand({
      TopicArn: config.fileEventsTopicArn,
    }),
  );
  const subscriptions = await snsClient().send(
    new ListSubscriptionsByTopicCommand({
      TopicArn: config.fileEventsTopicArn,
    }),
  );
  const processingTopic = await snsClient()
    .send(new GetTopicAttributesCommand({ TopicArn: config.processingEventsTopicArn }))
    .catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));

  patchStep(run, "sns-sqs", {
    status: "success",
    evidence: {
      topicArn: config.fileEventsTopicArn,
      fileEventsTopicArn: config.fileEventsTopicArn,
      processingEventsTopicArn: config.processingEventsTopicArn,
      topicKmsKeyId: topic.Attributes?.KmsMasterKeyId ?? "LocalStack may omit this attribute",
      processingTopic:
        "Attributes" in processingTopic
          ? {
              kmsKeyId:
                processingTopic.Attributes?.KmsMasterKeyId ??
                "LocalStack may omit this attribute",
            }
          : processingTopic,
      queueUrl: config.sqsQueueUrl,
      queueArn: queue.Attributes?.QueueArn,
      queueKmsKeyId: queue.Attributes?.KmsMasterKeyId ?? "LocalStack may omit this attribute",
      redrivePolicy: queue.Attributes?.RedrivePolicy,
      messagesAvailable: queue.Attributes?.ApproximateNumberOfMessages,
      messagesInFlight: queue.Attributes?.ApproximateNumberOfMessagesNotVisible,
      subscriptions: subscriptions.Subscriptions,
    },
  });
}

async function observeDlqAndLogs(run: FlowRun) {
  const config = getConfig();
  const [queue, dlq, health] = await Promise.all([
    sqsClient().send(
      new GetQueueAttributesCommand({
        QueueUrl: config.sqsQueueUrl,
        AttributeNames: ["All"],
      }),
    ),
    sqsClient().send(
      new GetQueueAttributesCommand({
        QueueUrl: config.processingDlqQueueUrl,
        AttributeNames: ["All"],
      }),
    ),
    getLocalStackHealth().catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);

  const healthRecord: Record<string, unknown> = isRecord(health) ? health : {};
  const services = isRecord(healthRecord.services) ? healthRecord.services : {};

  patchStep(run, "dlq-observability", {
    status: "success",
    evidence: {
      processingQueueName: config.sqsQueueName,
      processingQueueUrl: config.sqsQueueUrl,
      processingQueueArn: queue.Attributes?.QueueArn,
      redrivePolicy: queue.Attributes?.RedrivePolicy,
      processingDlqName: config.processingDlqQueueName,
      processingDlqQueueUrl: config.processingDlqQueueUrl,
      processingDlqArn: dlq.Attributes?.QueueArn,
      dlqMessages: dlq.Attributes?.ApproximateNumberOfMessages,
      dlqMessagesInFlight: dlq.Attributes?.ApproximateNumberOfMessagesNotVisible,
      cloudwatchService: services.cloudwatch ?? "not reported by LocalStack health",
      cloudwatchLogsService: services.logs ?? "not reported by LocalStack health",
      optionalAuditServices: {
        cloudtrail: services.cloudtrail ?? "enable with ENABLE_AUDIT_SERVICES=1",
        guardduty: services.guardduty ?? "enable with ENABLE_AUDIT_SERVICES=1",
        config: services.config ?? "enable with ENABLE_AUDIT_SERVICES=1",
      },
      runtimeLogSources:
        config.runtimeMode === "terraform-local"
          ? [
              `/aws/lambda/${config.processorLambdaName}`,
              `/aws/lambda/${config.outboxPublisherLambdaName}`,
              "/ecs/fsamp-local",
            ]
          : ["fsamp-e2e-gateway", "fsamp-e2e-processor", "fsamp-e2e-localstack"],
      dockerLogsEnabled: config.dockerLogsEnabled,
      correlationFilters: [
        run.fileId,
        run.correlationId,
        run.requestId,
        run.idempotencyKey,
        run.objectKey,
      ].filter(Boolean),
    },
  });
}

async function observeProcessor(run: FlowRun) {
  if (!run.fileId) return;
  const config = getConfig();
  const queue = await sqsClient().send(
    new GetQueueAttributesCommand({
      QueueUrl: config.sqsQueueUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  const processorLambda = await getBestEffortLambdaEvidence(
    config.processorLambdaName,
    queue.Attributes?.QueueArn,
  );
  const metadataItems = await queryByPk(config.metadataTableName, `FILE#${run.fileId}`, 10);
  const metadata = metadataItems[0];

  if (!metadata) {
    patchStep(run, "processor-consume", {
      status: "running",
      evidence: {
        tableName: config.metadataTableName,
        searchedPk: `FILE#${run.fileId}`,
        processorLambdaName: config.processorLambdaName,
        processorLambda,
      },
    });
    return;
  }

  const status = String(metadata.status ?? "");
  const completed = status === "COMPLETED";
  const failed = status === "FAILED";
  const terminalStatus: StepStatus = failed ? "failed" : completed ? "success" : "running";

  patchStep(run, "processor-consume", {
    status: "success",
    evidence: {
      tableName: config.metadataTableName,
      recordStatus: status,
      correlationId: metadata.correlationId,
      objectKey: metadata.objectKey,
      processorLambdaName: config.processorLambdaName,
      processorLambda,
    },
  });

  patchStep(run, "s3-read", {
    status: "success",
    evidence: {
      inferredFrom: "Processor metadata record exists after S3 read path.",
      objectKey: metadata.objectKey,
      isEncrypted: metadata.isEncrypted,
      kmsKeyId: metadata.kmsKeyId,
    },
  });

  patchStep(run, "processor-analysis", {
    status: terminalStatus,
    error: failed ? String(metadata.errorMessage ?? "Processor failed") : undefined,
    evidence: {
      fileHash: metadata.fileHash,
      isSafe: metadata.isSafe,
      scanFindings: metadata.scanFindings ?? [],
      processedAt: metadata.processedAt,
      errorCode: metadata.errorCode,
      errorMessage: metadata.errorMessage,
    },
  });

  patchStep(run, "dynamodb-metadata", {
    status: terminalStatus,
    error: failed ? String(metadata.errorMessage ?? "Processor failed") : undefined,
    evidence: {
      tableName: config.metadataTableName,
      item: metadata,
    },
  });
}

function finalizeRun(run: FlowRun) {
  const skipped = run.steps.filter((step) => step.status === "skipped").length;
  const failed = run.steps.filter((step) => step.status === "failed").length;
  const completed = run.steps.filter((step) => step.status === "success").length;
  const actionableTotal = run.steps.length - skipped;
  const pending = run.steps.filter((step) => step.status === "pending" || step.status === "running").length;

  run.summary = {
    completedSteps: completed,
    totalSteps: actionableTotal,
    lastObservedAt: new Date().toISOString(),
    verdict:
      failed > 0
        ? "Flow has failed evidence."
        : pending === 0
          ? "Full local flow verified."
          : "Flow is still collecting evidence.",
  };

  if (failed > 0) {
    run.status = "failed";
  } else if (pending === 0) {
    run.status = "success";
  } else if (completed > 0) {
    run.status = "running";
  } else {
    run.status = "idle";
  }
}

export async function collectEvidence(run: FlowRun): Promise<FlowRun> {
  const nextRun: FlowRun = {
    ...run,
    steps: normalizeRunSteps(run),
    errors: [...run.errors],
  };

  skipStepsForMode(nextRun);

  const observers: Array<() => Promise<void>> = [
    () => observeLocalStack(nextRun),
    () => observeCognito(nextRun),
    () => observeUpload(nextRun),
    () => observeIdempotency(nextRun),
    () => observeS3(nextRun),
    () => observeOutbox(nextRun),
    () => observeMessaging(nextRun),
    () => observeDlqAndLogs(nextRun),
    () => observeProcessor(nextRun),
  ];

  for (const observer of observers) {
    try {
      await observer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      nextRun.errors.push(message);

      if (message.includes("LocalStack")) failStep(nextRun, "localstack", error);
    }
  }

  finalizeRun(nextRun);
  return nextRun;
}
