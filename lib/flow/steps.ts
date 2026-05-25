import type { FlowStep, FlowStepDefinition, StepId } from "@/lib/flow/types";

export const FLOW_STEPS: FlowStepDefinition[] = [
  {
    id: "localstack",
    label: "LocalStack resources",
    shortLabel: "LocalStack",
    lane: "security",
    component: "AWS local control plane",
    description: "S3, KMS, SNS, SQS, DynamoDB and Cognito are reachable.",
    controls: [
      { control: "CM-2", label: "Baseline config" },
      { control: "SA-11", label: "Local validation" },
    ],
  },
  {
    id: "cognito",
    label: "Cognito authentication",
    shortLabel: "Cognito",
    lane: "ingress",
    component: "LocalStack Cognito",
    description: "Demo user token is issued before calling the gateway.",
    controls: [
      { control: "IA-2", label: "Identification" },
      { control: "AC-3", label: "Access enforcement" },
    ],
  },
  {
    id: "gateway-upload",
    label: "Gateway upload request",
    shortLabel: "Upload",
    lane: "ingress",
    component: "fsamp-gateway",
    description: "The file enters the platform through the authenticated REST API.",
    controls: [
      { control: "AC-4", label: "Information flow" },
      { control: "AU-12", label: "Audit event" },
    ],
  },
  {
    id: "gateway-validation",
    label: "Content validation and SHA-256",
    shortLabel: "Validate",
    lane: "security",
    component: "fsamp-gateway",
    description: "Gateway validates MIME type and computes a SHA-256 checksum.",
    controls: [
      { control: "SI-10", label: "Input validation" },
      { control: "SC-13", label: "Approved crypto" },
    ],
  },
  {
    id: "s3-store",
    label: "S3 PutObject with SSE-KMS",
    shortLabel: "S3 SSE-KMS",
    lane: "security",
    component: "S3 + KMS",
    description: "The object is persisted using server-side encryption with KMS.",
    controls: [
      { control: "SC-12", label: "Key management" },
      { control: "SC-28", label: "Data at rest" },
    ],
  },
  {
    id: "gateway-outbox",
    label: "Gateway metadata and outbox",
    shortLabel: "Outbox",
    lane: "persistence",
    component: "DynamoDB",
    description: "Gateway metadata and FILE_UPLOADED event are written transactionally.",
    controls: [
      { control: "AU-3", label: "Audit content" },
      { control: "CP-10", label: "Recovery support" },
    ],
  },
  {
    id: "sns-sqs",
    label: "SNS to SQS delivery",
    shortLabel: "SNS/SQS",
    lane: "eventing",
    component: "SNS + SQS",
    description: "The file event is delivered asynchronously to the processing queue.",
    controls: [
      { control: "SC-8", label: "Transport protection" },
      { control: "SC-28", label: "Encrypted messages" },
    ],
  },
  {
    id: "processor-consume",
    label: "Processor consumes event",
    shortLabel: "Consume",
    lane: "processing",
    component: "fsamp-processor",
    description: "Processor receives the FILE_UPLOADED event from SQS.",
    controls: [
      { control: "SI-4", label: "Monitoring" },
      { control: "AU-12", label: "Audit event" },
    ],
  },
  {
    id: "s3-read",
    label: "S3 GetObject and KMS decrypt",
    shortLabel: "Decrypt read",
    lane: "security",
    component: "S3 + KMS",
    description: "S3 returns plaintext only after KMS/IAM authorization succeeds.",
    controls: [
      { control: "AC-6", label: "Least privilege" },
      { control: "SC-13", label: "Cryptographic protection" },
    ],
  },
  {
    id: "processor-analysis",
    label: "Processor analysis",
    shortLabel: "Analyze",
    lane: "processing",
    component: "fsamp-processor",
    description: "Processor computes a hash and records the file safety result.",
    controls: [
      { control: "SI-3", label: "Malicious code protection" },
      { control: "SI-7", label: "Integrity checks" },
    ],
  },
  {
    id: "dynamodb-metadata",
    label: "DynamoDB processing metadata",
    shortLabel: "Metadata",
    lane: "persistence",
    component: "DynamoDB",
    description: "Final processing state is persisted to the metadata table.",
    controls: [
      { control: "AU-9", label: "Protected logs" },
      { control: "SC-28", label: "Data at rest" },
    ],
  },
  {
    id: "result-outbox",
    label: "Result outbox event",
    shortLabel: "Result",
    lane: "eventing",
    component: "DynamoDB outbox",
    description: "Processor writes the terminal FILE_PROCESSED or failure event.",
    controls: [
      { control: "AU-12", label: "Audit event" },
      { control: "CP-2", label: "Continuity evidence" },
    ],
  },
];

export const STEP_EDGES: Array<[StepId, StepId]> = [
  ["localstack", "cognito"],
  ["cognito", "gateway-upload"],
  ["gateway-upload", "gateway-validation"],
  ["gateway-validation", "s3-store"],
  ["s3-store", "gateway-outbox"],
  ["gateway-outbox", "sns-sqs"],
  ["sns-sqs", "processor-consume"],
  ["processor-consume", "s3-read"],
  ["s3-read", "processor-analysis"],
  ["processor-analysis", "dynamodb-metadata"],
  ["dynamodb-metadata", "result-outbox"],
];

export function createInitialSteps(): FlowStep[] {
  return FLOW_STEPS.map((step) => ({
    ...step,
    status: "pending",
  }));
}

export function terminalStepIdsForMode(mode: "upload" | "event"): StepId[] {
  if (mode === "event") {
    return ["cognito", "gateway-upload", "gateway-validation", "gateway-outbox"];
  }
  return [];
}
