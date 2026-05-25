import {
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { DescribeKeyCommand } from "@aws-sdk/client-kms";
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
import { terminalStepIdsForMode } from "@/lib/flow/steps";
import { dynamoClient, kmsClient, s3Client, snsClient, sqsClient } from "@/lib/server/aws";
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
    const payload = String(item.payload ?? "");
    return aggregateId === fileId || payload.includes(fileId);
  });
}

async function observeLocalStack(run: FlowRun) {
  const config = getConfig();
  const response = await fetch(`${config.awsEndpointUrl}/_localstack/health`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`LocalStack health returned ${response.status}`);
  }

  const health = (await response.json()) as Record<string, unknown>;
  const key = await kmsClient().send(new DescribeKeyCommand({ KeyId: config.kmsKeyId }));

  patchStep(run, "localstack", {
    status: "success",
    evidence: {
      endpoint: config.awsEndpointUrl,
      region: config.awsRegion,
      services: health.services,
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

  if (run.mode === "upload") {
    const gatewayOutbox = await queryByPk(config.outboxTableName, "OUTBOX#FileUpload", 25);
    const event = findMatchingOutbox(gatewayOutbox, run.fileId);

    patchStep(run, "gateway-outbox", {
      status: event ? "success" : "running",
      evidence: {
        tableName: config.outboxTableName,
        searchedPk: "OUTBOX#FileUpload",
        event: event ?? "not found yet",
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
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );
  const topic = await snsClient().send(
    new GetTopicAttributesCommand({
      TopicArn: config.snsTopicArn,
    }),
  );
  const subscriptions = await snsClient().send(
    new ListSubscriptionsByTopicCommand({
      TopicArn: config.snsTopicArn,
    }),
  );

  patchStep(run, "sns-sqs", {
    status: "success",
    evidence: {
      topicArn: config.snsTopicArn,
      topicKmsKeyId: topic.Attributes?.KmsMasterKeyId ?? "LocalStack may omit this attribute",
      queueUrl: config.sqsQueueUrl,
      queueArn: queue.Attributes?.QueueArn,
      queueKmsKeyId: queue.Attributes?.KmsMasterKeyId ?? "LocalStack may omit this attribute",
      messagesAvailable: queue.Attributes?.ApproximateNumberOfMessages,
      messagesInFlight: queue.Attributes?.ApproximateNumberOfMessagesNotVisible,
      subscriptions: subscriptions.Subscriptions,
    },
  });
}

async function observeProcessor(run: FlowRun) {
  if (!run.fileId) return;
  const config = getConfig();
  const metadataItems = await queryByPk(config.metadataTableName, `FILE#${run.fileId}`, 10);
  const metadata = metadataItems[0];

  if (!metadata) {
    patchStep(run, "processor-consume", {
      status: "running",
      evidence: {
        tableName: config.metadataTableName,
        searchedPk: `FILE#${run.fileId}`,
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
    steps: run.steps.map((step) => ({ ...step })),
    errors: [...run.errors],
  };

  skipStepsForMode(nextRun);

  const observers: Array<() => Promise<void>> = [
    () => observeLocalStack(nextRun),
    () => observeCognito(nextRun),
    () => observeUpload(nextRun),
    () => observeS3(nextRun),
    () => observeOutbox(nextRun),
    () => observeMessaging(nextRun),
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
