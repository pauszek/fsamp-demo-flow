import {
  DescribeTableCommand,
  GetItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { DescribeKeyCommand } from "@aws-sdk/client-kms";
import { GetFunctionCommand, ListEventSourceMappingsCommand } from "@aws-sdk/client-lambda";
import { GetBucketEncryptionCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { GetTopicAttributesCommand, ListSubscriptionsByTopicCommand } from "@aws-sdk/client-sns";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import { createInitialSteps, terminalStepIdsForMode } from "@/lib/flow/steps";
import type { FlowEvidence, FlowRun, StepId, StepStatus } from "@/lib/flow/types";
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
import { sanitizeDiagnostic } from "@/lib/server/security";

const EVENT_SCHEMA_VERSION = "1.2.0";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_EVENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

type StepPatch = {
  status: StepStatus;
  evidence?: FlowEvidence;
  error?: string;
};

type Observer = {
  steps: StepId[];
  collect: () => Promise<void>;
};

function patchStep(run: FlowRun, stepId: StepId, patch: StepPatch) {
  const now = new Date().toISOString();
  run.steps = run.steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          ...patch,
          error: patch.error,
          startedAt: step.startedAt ?? now,
          completedAt: ["success", "failed", "skipped"].includes(patch.status)
            ? now
            : undefined,
        }
      : step,
  );
}

function normalizeRunSteps(run: FlowRun) {
  const storedSteps = new Map(run.steps.map((step) => [step.id, step]));
  return createInitialSteps().map((definition) => {
    const stored = storedSteps.get(definition.id);
    return stored
      ? {
          ...definition,
          status: stored.status,
          startedAt: stored.startedAt,
          completedAt: stored.completedAt,
          evidence: stored.evidence,
          error: stored.error,
        }
      : definition;
  });
}

function failStep(run: FlowRun, stepId: StepId, error: unknown) {
  patchStep(run, stepId, {
    status: "failed",
    error: sanitizeDiagnostic(error),
  });
}

function skipStepsForMode(run: FlowRun) {
  for (const stepId of terminalStepIdsForMode(run.mode)) {
    patchStep(run, stepId, {
      status: "skipped",
      evidence: { reason: "Direct event mode bypasses the gateway upload path." },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNativeItem(item?: Record<string, AttributeValue>) {
  return item ? (unmarshall(item) as Record<string, unknown>) : undefined;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Set) return [...value].map(jsonSafe);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

function healthyService(value: unknown) {
  const status = String(value ?? "").toLowerCase();
  return Boolean(status) && !["disabled", "error", "failed", "stopped", "unavailable"].includes(status);
}

function parsePayload(item?: Record<string, unknown>) {
  if (!item) return undefined;
  let payload: unknown = item.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  if (isRecord(payload) && typeof payload.Message === "string") {
    try {
      payload = JSON.parse(payload.Message);
    } catch {
      return undefined;
    }
  }
  return isRecord(payload) ? payload : undefined;
}

export function validateEvent(
  event: Record<string, unknown> | undefined,
  run: FlowRun,
  expectedTypes: string[],
  expectedSource: string,
) {
  if (!event || !run.fileId || !run.correlationId) return false;
  if (
    event.schemaVersion !== EVENT_SCHEMA_VERSION ||
    event.fileId !== run.fileId ||
    event.correlationId !== run.correlationId ||
    !UUID_V4.test(String(event.fileId)) ||
    !UUID_V4.test(String(event.correlationId)) ||
    !UUID_EVENT.test(String(event.eventId)) ||
    !expectedTypes.includes(String(event.eventType)) ||
    event.source !== expectedSource ||
    !Number.isFinite(Date.parse(String(event.timestamp)))
  ) {
    return false;
  }

  const metadata = event.fileMetadata;
  const storage = event.storageLocation;
  const security = event.securityContext;
  if (!isRecord(metadata) || !isRecord(storage) || !isRecord(security)) return false;
  if (
    metadata.originalFilename !== run.input.filename ||
    Number(metadata.fileSizeBytes) !== run.input.sizeBytes ||
    storage.bucketName !== (run.bucketName ?? getConfig().s3BucketName) ||
    storage.objectKey !== run.objectKey ||
    security.isEncrypted !== true ||
    !String(security.kmsKeyId ?? "")
  ) {
    return false;
  }

  if (event.eventType === "ANALYSIS_COMPLETED") {
    const result = event.processingResult;
    return (
      isRecord(result) &&
      typeof result.isSafe === "boolean" &&
      Array.isArray(result.findings) &&
      Number.isFinite(Date.parse(String(result.processedAt))) &&
      event.failure === undefined
    );
  }
  if (event.eventType === "PROCESSING_FAILED") {
    const failure = event.failure;
    return (
      isRecord(failure) &&
      Boolean(failure.code) &&
      Boolean(failure.message) &&
      typeof failure.retryable === "boolean" &&
      Number.isFinite(Date.parse(String(failure.failedAt))) &&
      event.processingResult === undefined
    );
  }
  return event.processingResult === undefined && event.failure === undefined;
}

async function getLocalStackHealth() {
  const response = await fetch(`${getConfig().awsEndpointUrl}/_localstack/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`LocalStack health returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

async function queryByPartition(
  tableName: string,
  keyName: string,
  keyValue: string,
  limit = 10,
) {
  const response = await dynamoClient().send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "#partition = :partition",
      ExpressionAttributeNames: { "#partition": keyName },
      ExpressionAttributeValues: { ":partition": { S: keyValue } },
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (response.Items ?? []).map(asNativeItem).filter(Boolean) as Record<string, unknown>[];
}

async function getMetadata(fileId: string) {
  const response = await dynamoClient().send(
    new GetItemCommand({
      TableName: getConfig().metadataTableName,
      Key: {
        PK: { S: `FILE#${fileId}` },
        SK: { S: "METADATA" },
      },
      ConsistentRead: true,
    }),
  );
  return asNativeItem(response.Item);
}

async function getOutbox(aggregateType: "FileUpload" | "FileProcessing", fileId: string) {
  const items = await queryByPartition(
    getConfig().outboxTableName,
    "PK",
    `OUTBOX#${aggregateType}#${fileId}`,
    5,
  );
  return items.find((item) => item.aggregateId === fileId);
}

async function getLambdaEvidence(functionName: string, eventSourceArn?: string) {
  const [fn, mappings] = await Promise.all([
    lambdaClient().send(new GetFunctionCommand({ FunctionName: functionName })),
    lambdaClient().send(
      new ListEventSourceMappingsCommand({
        FunctionName: functionName,
        EventSourceArn: eventSourceArn,
      }),
    ),
  ]);
  return {
    functionName,
    functionArn: fn.Configuration?.FunctionArn,
    state: fn.Configuration?.State,
    lastUpdateStatus: fn.Configuration?.LastUpdateStatus,
    eventSourceMappings: (mappings.EventSourceMappings ?? []).map((mapping) => ({
      uuid: mapping.UUID,
      state: mapping.State,
      eventSourceArn: mapping.EventSourceArn,
      lastProcessingResult: mapping.LastProcessingResult,
    })),
  };
}

async function observeLocalStack(run: FlowRun) {
  const config = getConfig();
  const [health, key] = await Promise.all([
    getLocalStackHealth(),
    kmsClient().send(new DescribeKeyCommand({ KeyId: config.kmsKeyId })),
  ]);
  const services = isRecord(health.services) ? health.services : {};
  const required = ["s3", "dynamodb", "sns", "sqs", "kms", "cognito-idp", "lambda", "logs"];
  const unavailable = required.filter((service) => !healthyService(services[service]));
  if (unavailable.length || key.KeyMetadata?.KeyState !== "Enabled" || !key.KeyMetadata?.Arn) {
    throw new Error(`Required local services are unavailable: ${unavailable.join(", ") || "KMS"}`);
  }
  patchStep(run, "localstack", {
    status: "success",
    evidence: {
      endpoint: config.awsEndpointUrl,
      region: config.awsRegion,
      requiredServices: Object.fromEntries(required.map((name) => [name, services[name]])),
      kmsKeyState: key.KeyMetadata.KeyState,
      kmsKeyArn: key.KeyMetadata.Arn,
    },
  });
}

async function observeCognito(run: FlowRun) {
  if (run.mode === "event") return;
  const ids = await discoverCognitoIds();
  if (!ids.userPoolId || !ids.clientId) throw new Error("Cognito demo identity is incomplete");
  patchStep(run, "cognito", {
    status: "success",
    evidence: { ...ids, authFlow: "ADMIN_NO_SRP_AUTH" },
  });
}

async function observeUpload(run: FlowRun) {
  if (run.mode === "event") return;
  const upload = run.uploadResponse;
  if (!upload) {
    patchStep(run, "gateway-upload", { status: "running" });
    patchStep(run, "gateway-validation", { status: "running" });
    return;
  }
  if (
    upload.status !== "UPLOADED" ||
    upload.fileId !== run.fileId ||
    upload.correlationId !== run.correlationId ||
    !UUID_V4.test(run.fileId ?? "") ||
    !UUID_V4.test(run.correlationId ?? "")
  ) {
    throw new Error("Gateway upload response does not match the run");
  }
  const validContent =
    upload.filename === run.input.filename &&
    Number(upload.sizeBytes) === run.input.sizeBytes &&
    upload.mimeType === run.input.contentType &&
    SHA256.test(upload.checksum ?? "");
  patchStep(run, "gateway-upload", {
    status: "success",
    evidence: {
      fileId: run.fileId,
      correlationId: run.correlationId,
      requestId: run.requestId,
      idempotencyKey: run.idempotencyKey,
      responseStatus: upload.status,
    },
  });
  patchStep(run, "gateway-validation", {
    status: validContent ? "success" : "failed",
    error: validContent ? undefined : "Gateway content evidence does not match the uploaded file",
    evidence: {
      filename: upload.filename,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      checksumSha256: upload.checksum,
    },
  });
}

async function observeIdempotency(run: FlowRun) {
  if (run.mode === "event") return;
  if (!run.idempotencyKey) {
    patchStep(run, "idempotency", { status: "running" });
    return;
  }
  const records = await queryByPartition(
    getConfig().idempotencyTableName,
    "idempotencyKey",
    run.idempotencyKey,
    2,
  );
  const record = records[0];
  const status = String(record?.status ?? "");
  if (status === "FAILED") throw new Error("Gateway idempotency record failed");
  patchStep(run, "idempotency", {
    status: status === "COMPLETED" && records.length === 1 ? "success" : "running",
    evidence: {
      tableName: getConfig().idempotencyTableName,
      idempotencyKey: run.idempotencyKey,
      recordStatus: status || "not found",
      recordsFound: records.length,
    },
  });
}

async function observeS3(run: FlowRun) {
  if (!run.fileId) {
    patchStep(run, "s3-store", { status: "running" });
    return;
  }
  const config = getConfig();
  const metadata = await getMetadata(run.fileId);
  const objectKey = run.objectKey ?? run.directEvent?.objectKey ?? String(metadata?.objectKey ?? "");
  if (!objectKey) {
    patchStep(run, "s3-store", { status: "running", evidence: { fileId: run.fileId } });
    return;
  }
  const [head, encryption, key] = await Promise.all([
    s3Client().send(new HeadObjectCommand({ Bucket: config.s3BucketName, Key: objectKey })),
    s3Client().send(new GetBucketEncryptionCommand({ Bucket: config.s3BucketName })),
    kmsClient().send(new DescribeKeyCommand({ KeyId: config.kmsKeyId })),
  ]);
  const expectedChecksum = run.directEvent?.checksumSha256 ?? run.uploadResponse?.checksum;
  const actualChecksum = head.Metadata?.["checksum-sha256"];
  const rules = encryption.ServerSideEncryptionConfiguration?.Rules ?? [];
  const bucketUsesKms = rules.some(
    (rule) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "aws:kms",
  );
  const kmsMatches =
    Boolean(head.SSEKMSKeyId) &&
    (head.SSEKMSKeyId === key.KeyMetadata?.Arn ||
      head.SSEKMSKeyId === key.KeyMetadata?.KeyId ||
      head.SSEKMSKeyId === config.kmsKeyId);
  if (
    head.ServerSideEncryption !== "aws:kms" ||
    !kmsMatches ||
    !bucketUsesKms ||
    head.ContentLength !== run.input.sizeBytes ||
    !expectedChecksum ||
    actualChecksum !== expectedChecksum
  ) {
    throw new Error("S3 object evidence failed size, checksum, or SSE-KMS validation");
  }
  run.objectKey = objectKey;
  run.bucketName = config.s3BucketName;
  patchStep(run, "s3-store", {
    status: "success",
    evidence: {
      bucketName: config.s3BucketName,
      objectKey,
      contentType: head.ContentType,
      contentLength: head.ContentLength,
      checksumSha256: actualChecksum,
      serverSideEncryption: head.ServerSideEncryption,
      sseKmsKeyId: head.SSEKMSKeyId,
      bucketDefaultEncryption: "aws:kms",
    },
  });
}

async function hydrateRunStorage(run: FlowRun) {
  if (!run.fileId) return;
  const metadata = await getMetadata(run.fileId);
  run.objectKey = run.objectKey ?? (String(metadata?.objectKey ?? "") || undefined);
  run.bucketName =
    run.bucketName ?? (String(metadata?.bucketName ?? "") || getConfig().s3BucketName);
}

async function observeGatewayOutbox(run: FlowRun) {
  if (run.mode === "event") return;
  if (!run.fileId) {
    patchStep(run, "gateway-outbox", { status: "running" });
    patchStep(run, "outbox-publish", { status: "running" });
    return;
  }
  const config = getConfig();
  await hydrateRunStorage(run);
  const table = await dynamoClient().send(
    new DescribeTableCommand({ TableName: config.outboxTableName }),
  );
  const streamArn = table.Table?.LatestStreamArn;
  const event = await getOutbox("FileUpload", run.fileId);
  const payload = parsePayload(event);
  const contractValid = validateEvent(payload, run, ["FILE_UPLOADED"], "fsamp-gateway");
  if (event && !contractValid) throw new Error("Gateway outbox payload violates schema 1.2.0");
  const status = String(event?.status ?? "");
  if (status === "FAILED") throw new Error("Gateway outbox publication failed");
  patchStep(run, "gateway-outbox", {
    status: event && contractValid ? "success" : "running",
    evidence: {
      tableName: config.outboxTableName,
      searchedPk: `OUTBOX#FileUpload#${run.fileId}`,
      eventId: event?.eventId,
      eventType: event?.eventType,
      schemaVersion: payload?.schemaVersion,
    },
  });

  let publisher: Awaited<ReturnType<typeof getLambdaEvidence>> | undefined;
  if (!config.directPublishAfterOutbox) {
    if (!streamArn) throw new Error("Outbox DynamoDB stream is not enabled");
    publisher = await getLambdaEvidence(config.outboxPublisherLambdaName, streamArn);
    if (
      publisher.state !== "Active" ||
      !publisher.eventSourceMappings.some((mapping) => mapping.state === "Enabled")
    ) {
      throw new Error("Outbox publisher Lambda mapping is not active");
    }
  }
  patchStep(run, "outbox-publish", {
    status: status === "PUBLISHED" && Boolean(event?.publishedAt) ? "success" : "running",
    evidence: {
      outboxStatus: status || "not found",
      publishedAt: event?.publishedAt,
      latestStreamArn: streamArn,
      publishPath: config.directPublishAfterOutbox
        ? "local direct publisher"
        : "DynamoDB Streams -> outbox-publisher Lambda -> SNS",
      publisher,
    },
  });
}

async function observeResultOutbox(run: FlowRun) {
  if (!run.fileId) {
    patchStep(run, "result-outbox", { status: "running" });
    return;
  }
  await hydrateRunStorage(run);
  const config = getConfig();
  const result = await getOutbox("FileProcessing", run.fileId);
  const resultPayload = parsePayload(result);
  const resultValid = validateEvent(
    resultPayload,
    run,
    ["ANALYSIS_COMPLETED", "PROCESSING_FAILED"],
    "fsamp-processor",
  );
  const resultStatus = String(result?.status ?? "");
  if (result && !resultValid) throw new Error("Processor outbox payload violates schema 1.2.0");
  if (resultStatus === "FAILED") throw new Error("Processor result publication failed");
  patchStep(run, "result-outbox", {
    status:
      resultValid && resultStatus === "PUBLISHED" && Boolean(result?.publishedAt)
        ? "success"
        : "running",
    evidence: {
      tableName: config.outboxTableName,
      searchedPk: `OUTBOX#FileProcessing#${run.fileId}`,
      outboxStatus: resultStatus || "not found",
      eventId: result?.eventId,
      eventType: resultPayload?.eventType,
      schemaVersion: resultPayload?.schemaVersion,
      publishedAt: result?.publishedAt,
    },
  });
}

async function observeMessaging(run: FlowRun) {
  if (!run.fileId) {
    patchStep(run, "sns-sqs", { status: "running" });
    return;
  }
  const config = getConfig();
  const [queue, fileTopic, resultTopic, subscriptions, metadata] = await Promise.all([
    sqsClient().send(
      new GetQueueAttributesCommand({
        QueueUrl: config.sqsQueueUrl,
        AttributeNames: ["QueueArn", "KmsMasterKeyId", "RedrivePolicy"],
      }),
    ),
    snsClient().send(new GetTopicAttributesCommand({ TopicArn: config.fileEventsTopicArn })),
    snsClient().send(new GetTopicAttributesCommand({ TopicArn: config.processingEventsTopicArn })),
    snsClient().send(new ListSubscriptionsByTopicCommand({ TopicArn: config.fileEventsTopicArn })),
    getMetadata(run.fileId),
  ]);
  const queueArn = queue.Attributes?.QueueArn;
  const subscribed = subscriptions.Subscriptions?.some(
    (subscription) =>
      subscription.Protocol === "sqs" &&
      subscription.Endpoint === queueArn &&
      subscription.SubscriptionArn &&
      subscription.SubscriptionArn !== "PendingConfirmation",
  );
  const encrypted = Boolean(
    queue.Attributes?.KmsMasterKeyId &&
      fileTopic.Attributes?.KmsMasterKeyId &&
      resultTopic.Attributes?.KmsMasterKeyId,
  );
  if (!queueArn || !subscribed || !encrypted) {
    throw new Error("SNS/SQS subscription or KMS configuration is incomplete");
  }
  const gatewayPublished =
    run.mode === "event"
      ? Boolean(run.directEvent?.messageId)
      : String((await getOutbox("FileUpload", run.fileId))?.status ?? "") === "PUBLISHED";
  const processorConsumed = ["SCANNING", "PROCESSING", "COMPLETED", "FAILED"].includes(
    String(metadata?.status ?? ""),
  );
  patchStep(run, "sns-sqs", {
    status: gatewayPublished && processorConsumed ? "success" : "running",
    evidence: {
      fileEventsTopicArn: config.fileEventsTopicArn,
      processingEventsTopicArn: config.processingEventsTopicArn,
      queueArn,
      subscriptionConfirmed: subscribed,
      kmsEncrypted: encrypted,
      gatewayPublished,
      processorConsumed,
    },
  });
}

async function observeDlqAndLogs(run: FlowRun) {
  const config = getConfig();
  const [queue, dlq, health] = await Promise.all([
    sqsClient().send(
      new GetQueueAttributesCommand({ QueueUrl: config.sqsQueueUrl, AttributeNames: ["All"] }),
    ),
    sqsClient().send(
      new GetQueueAttributesCommand({
        QueueUrl: config.processingDlqQueueUrl,
        AttributeNames: ["All"],
      }),
    ),
    getLocalStackHealth(),
  ]);
  const dlqArn = dlq.Attributes?.QueueArn;
  let redrive: Record<string, unknown> = {};
  try {
    redrive = JSON.parse(queue.Attributes?.RedrivePolicy ?? "{}") as Record<string, unknown>;
  } catch {
    throw new Error("SQS redrive policy is invalid JSON");
  }
  const dlqMessages = Number(dlq.Attributes?.ApproximateNumberOfMessages ?? "0");
  const dlqInFlight = Number(dlq.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0");
  const services = isRecord(health.services) ? health.services : {};
  if (
    !dlqArn ||
    redrive.deadLetterTargetArn !== dlqArn ||
    Number(redrive.maxReceiveCount) < 1 ||
    dlqMessages > 0 ||
    dlqInFlight > 0 ||
    !healthyService(services.logs)
  ) {
    throw new Error("DLQ, redrive policy, or log service evidence is unhealthy");
  }
  patchStep(run, "dlq-observability", {
    status: "success",
    evidence: {
      processingQueueArn: queue.Attributes?.QueueArn,
      processingDlqArn: dlqArn,
      redrivePolicy: redrive,
      dlqMessages,
      dlqMessagesInFlight: dlqInFlight,
      logsService: services.logs,
      correlationFilters: [run.fileId, run.correlationId, run.requestId, run.objectKey].filter(Boolean),
    },
  });
}

async function observeProcessor(run: FlowRun) {
  if (!run.fileId) {
    for (const step of ["processor-consume", "s3-read", "processor-analysis", "dynamodb-metadata"] as StepId[]) {
      patchStep(run, step, { status: "running" });
    }
    return;
  }
  const config = getConfig();
  const metadata = await getMetadata(run.fileId);
  if (!metadata) {
    patchStep(run, "processor-consume", { status: "running" });
    return;
  }
  if (
    metadata.PK !== `FILE#${run.fileId}` ||
    metadata.SK !== "METADATA" ||
    metadata.entityType !== "FILE_METADATA" ||
    metadata.fileId !== run.fileId ||
    metadata.originalFilename !== run.input.filename ||
    metadata.correlationId !== run.correlationId
  ) {
    throw new Error("Canonical DynamoDB metadata identity does not match the run");
  }
  const status = String(metadata.status ?? "");
  const processingObserved = ["SCANNING", "PROCESSING", "COMPLETED", "FAILED"].includes(status);
  const completed = status === "COMPLETED";
  const failed = status === "FAILED";
  const checksum = String(metadata.checksumSHA256 ?? "");
  const fileHash = String(metadata.fileHash ?? "");
  const s3ReadVerified =
    processingObserved &&
    metadata.isEncrypted === true &&
    metadata.objectKey === run.objectKey &&
    SHA256.test(fileHash) &&
    fileHash === checksum;

  let processorLambda: Awaited<ReturnType<typeof getLambdaEvidence>> | undefined;
  if (config.runtimeMode === "terraform-local") {
    const queue = await sqsClient().send(
      new GetQueueAttributesCommand({ QueueUrl: config.sqsQueueUrl, AttributeNames: ["QueueArn"] }),
    );
    processorLambda = await getLambdaEvidence(config.processorLambdaName, queue.Attributes?.QueueArn);
    if (
      processorLambda.state !== "Active" ||
      !processorLambda.eventSourceMappings.some((mapping) => mapping.state === "Enabled")
    ) {
      throw new Error("Processor Lambda mapping is not active");
    }
  }

  patchStep(run, "processor-consume", {
    status: processingObserved ? "success" : "running",
    evidence: {
      tableName: config.metadataTableName,
      key: { PK: metadata.PK, SK: metadata.SK },
      recordStatus: status,
      lastProcessedEventId: metadata.lastProcessedEventId,
      processorLambda,
    },
  });
  patchStep(run, "s3-read", {
    status: s3ReadVerified ? "success" : processingObserved ? "failed" : "running",
    error:
      processingObserved && !s3ReadVerified
        ? "Processor read evidence does not match the encrypted object checksum"
        : undefined,
    evidence: {
      objectKey: metadata.objectKey,
      isEncrypted: metadata.isEncrypted,
      kmsKeyId: metadata.kmsKeyId,
      checksumSHA256: checksum,
      fileHash,
    },
  });

  const terminalStatus: StepStatus = failed ? "failed" : completed ? "success" : "running";
  const terminalValid = failed
    ? Boolean(metadata.errorCode && metadata.errorMessage && metadata.processedAt)
    : Boolean(
        completed &&
          metadata.processedAt &&
          typeof metadata.isSafe === "boolean" &&
          Array.isArray(jsonSafe(metadata.scanFindings ?? [])),
      );
  patchStep(run, "processor-analysis", {
    status: terminalStatus === "running" ? "running" : terminalValid ? terminalStatus : "failed",
    error: failed
      ? sanitizeDiagnostic(metadata.errorMessage ?? "Processor failed")
      : completed && !terminalValid
        ? "Processor completion evidence is incomplete"
        : undefined,
    evidence: {
      fileHash,
      isSafe: metadata.isSafe,
      scanFindings: jsonSafe(metadata.scanFindings ?? []),
      processedAt: metadata.processedAt,
      errorCode: metadata.errorCode,
    },
  });
  patchStep(run, "dynamodb-metadata", {
    status: terminalStatus === "running" ? "running" : terminalValid ? terminalStatus : "failed",
    error: failed ? sanitizeDiagnostic(metadata.errorMessage ?? "Processor failed") : undefined,
    evidence: {
      tableName: config.metadataTableName,
      item: jsonSafe({
        PK: metadata.PK,
        SK: metadata.SK,
        entityType: metadata.entityType,
        fileId: metadata.fileId,
        correlationId: metadata.correlationId,
        originalFilename: metadata.originalFilename,
        objectKey: metadata.objectKey,
        status: metadata.status,
        checksumSHA256: metadata.checksumSHA256,
        fileHash: metadata.fileHash,
        isSafe: metadata.isSafe,
        scanFindings: metadata.scanFindings,
        processedAt: metadata.processedAt,
      }),
    },
  });
}

function finalizeRun(run: FlowRun) {
  const config = getConfig();
  const expired = Date.now() - Date.parse(run.createdAt) > config.evidenceTimeoutSeconds * 1000;
  if (expired) {
    for (const step of run.steps) {
      if (step.status === "pending" || step.status === "running") {
        failStep(run, step.id, "Evidence collection timed out");
      }
    }
  }
  const skipped = run.steps.filter((step) => step.status === "skipped").length;
  const failed = run.steps.filter((step) => step.status === "failed").length;
  const completed = run.steps.filter((step) => step.status === "success").length;
  const pending = run.steps.filter((step) => ["pending", "running"].includes(step.status)).length;
  run.summary = {
    completedSteps: completed,
    totalSteps: run.steps.length - skipped,
    lastObservedAt: new Date().toISOString(),
    verdict:
      failed > 0
        ? "Flow evidence failed validation."
        : pending === 0
          ? "Full local flow verified."
          : "Flow is still collecting evidence.",
  };
  run.status = failed > 0 ? "failed" : pending === 0 ? "success" : completed > 0 ? "running" : "idle";
}

async function withTimeout<T>(operation: Promise<T>, milliseconds = 12_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Evidence observer timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectEvidence(run: FlowRun): Promise<FlowRun> {
  const nextRun: FlowRun = {
    ...run,
    steps: normalizeRunSteps(run),
    errors: [...new Set(run.errors.map((error) => sanitizeDiagnostic(error)))],
  };
  skipStepsForMode(nextRun);
  const observers: Observer[] = [
    { steps: ["localstack"], collect: () => observeLocalStack(nextRun) },
    { steps: ["cognito"], collect: () => observeCognito(nextRun) },
    { steps: ["gateway-upload", "gateway-validation"], collect: () => observeUpload(nextRun) },
    { steps: ["idempotency"], collect: () => observeIdempotency(nextRun) },
    { steps: ["s3-store"], collect: () => observeS3(nextRun) },
    {
      steps: ["gateway-outbox", "outbox-publish"],
      collect: () => observeGatewayOutbox(nextRun),
    },
    { steps: ["result-outbox"], collect: () => observeResultOutbox(nextRun) },
    { steps: ["sns-sqs"], collect: () => observeMessaging(nextRun) },
    { steps: ["dlq-observability"], collect: () => observeDlqAndLogs(nextRun) },
    {
      steps: ["processor-consume", "s3-read", "processor-analysis", "dynamodb-metadata"],
      collect: () => observeProcessor(nextRun),
    },
  ];
  const results = await Promise.allSettled(
    observers.map((observer) => withTimeout(observer.collect())),
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const message = sanitizeDiagnostic(result.reason);
    nextRun.errors = [...new Set([...nextRun.errors, message])];
    for (const stepId of observers[index].steps) {
      const step = nextRun.steps.find((candidate) => candidate.id === stepId);
      if (step?.status !== "skipped") failStep(nextRun, stepId, message);
    }
  });
  finalizeRun(nextRun);
  return nextRun;
}
