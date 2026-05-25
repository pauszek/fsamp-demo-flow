export type FlowMode = "upload" | "event";

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export type RunStatus = "idle" | "running" | "success" | "failed" | "partial";

export type StepId =
  | "localstack"
  | "cognito"
  | "gateway-upload"
  | "gateway-validation"
  | "s3-store"
  | "gateway-outbox"
  | "sns-sqs"
  | "processor-consume"
  | "s3-read"
  | "processor-analysis"
  | "dynamodb-metadata"
  | "result-outbox";

export type FlowEvidence = Record<string, unknown>;

export type ComplianceTag = {
  control: string;
  label: string;
};

export type FlowStepDefinition = {
  id: StepId;
  label: string;
  shortLabel: string;
  lane: "ingress" | "security" | "eventing" | "processing" | "persistence";
  component: string;
  description: string;
  controls: ComplianceTag[];
};

export type FlowStep = FlowStepDefinition & {
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  evidence?: FlowEvidence;
  error?: string;
};

export type UploadResponse = {
  fileId?: string;
  correlationId?: string;
  filename?: string;
  sizeBytes?: number;
  sizeHuman?: string;
  mimeType?: string;
  checksum?: string;
  status?: string;
  statusDescription?: string;
  uploadedAt?: string;
  message?: string;
  [key: string]: unknown;
};

export type DirectEvent = {
  eventId: string;
  fileId: string;
  correlationId: string;
  objectKey: string;
  bucketName: string;
  topicArn: string;
  checksumSha256: string;
  messageId?: string;
};

export type FlowRunInput = {
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type FlowRun = {
  id: string;
  mode: FlowMode;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  input: FlowRunInput;
  fileId?: string;
  correlationId?: string;
  objectKey?: string;
  bucketName?: string;
  uploadResponse?: UploadResponse;
  directEvent?: DirectEvent;
  steps: FlowStep[];
  errors: string[];
  summary: {
    completedSteps: number;
    totalSteps: number;
    lastObservedAt?: string;
    verdict?: string;
  };
};

export type RunListItem = Pick<
  FlowRun,
  "id" | "mode" | "status" | "createdAt" | "updatedAt" | "fileId" | "correlationId"
> & {
  filename: string;
};

export type DemoLogBundle = {
  runId: string;
  filters: string[];
  containers: Array<{
    name: string;
    available: boolean;
    matchedLines: string[];
    tail: string[];
    error?: string;
  }>;
};
