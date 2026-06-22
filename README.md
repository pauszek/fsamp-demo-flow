# FSAMP Local Flow Console

Local-only Next.js console for visualizing the FSAMP event-driven file-processing flow.

The console is not part of the production security boundary. It is a thesis/demo tool that observes the local LocalStack environment and presents evidence for each step of the flow:

```text
Upload -> Gateway -> Idempotency -> S3 SSE-KMS -> DynamoDB Outbox
       -> DynamoDB Streams -> Outbox Lambda -> SNS/SQS -> DLQ/log guardrails
       -> Processor Lambda -> DynamoDB -> Result Outbox
```

## Stack

| Layer | Technology |
|---|---|
| UI | Next.js, React, TypeScript, React Flow |
| Local backend | Next.js route handlers |
| AWS simulation | LocalStack through AWS SDK v3 |
| Runtime evidence | API Gateway, ECS gateway, S3, KMS, SNS, SQS, DLQ, DynamoDB, Lambda event-source mappings, CloudWatch Logs |

## Local Run

The quickest path is the Makefile:

```bash
cp .env.example .env.local
# Fill LOCALSTACK_AUTH_TOKEN in .env.local
make demo
```

This provisions the Terraform-managed LocalStack Pro parity stack first, then
generates `.env.local` from Terraform outputs and starts the console.

Useful targets:

| Target | Purpose |
|---|---|
| `make demo` | Provision Terraform-managed LocalStack Pro parity and run the console |
| `make demo-fast` | Run the old fast Docker Compose fallback |
| `make stack-fast` | Build local images and start LocalStack, gateway and processor containers |
| `make images` | Build gateway and processor images from local repos |
| `make app` | Run only the Next.js console |
| `make e2e` | Run the existing FSAMP e2e test container |
| `make health` | Check LocalStack, API Gateway/edge or fast-compose services |
| `make logs` | Tail CloudWatch Logs in parity mode, Docker logs in fast mode |
| `make stop` | Stop the Docker stack |
| `make reset` | Stop stack, remove volumes and clear `.demo-runs` |

Fast-compose commands are still available when you explicitly want the shorter
non-1:1 developer path:

```bash
cd ../fsamp-infra/e2e
set -a; source ../../fsamp-demo-flow/.env.local; set +a
docker compose up -d localstack gateway processor
```

Then run the console:

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Modes

| Mode | What it does |
|---|---|
| Upload | Authenticates against LocalStack Cognito, uploads a file to `fsamp-gateway`, then observes the full downstream path |
| Event | Writes a demo object to LocalStack S3 with SSE-KMS and publishes a `FILE_UPLOADED` event directly to SNS |
| Replay | Replays the latest captured run from `.demo-runs` for presentation-safe walkthroughs |

## Fidelity Modes

The default `make demo` path is the LocalStack Pro parity path. It uses the same
Terraform modules as AWS and follows the runtime service chain:

```text
API Gateway -> ALB -> ECS gateway -> S3/KMS + DynamoDB outbox
-> DynamoDB Streams -> outbox-publisher Lambda -> SNS
-> SQS -> processor Lambda -> DynamoDB/result outbox
```

The generated `.env.local` records this explicitly:

```text
DIRECT_PUBLISH_AFTER_OUTBOX=false
FSAMP_DEMO_RUNTIME=terraform-local
GATEWAY_UPLOAD_PATH=/files/upload
GATEWAY_HEALTH_PATH=/health
```

`make demo-fast` keeps the old compose path for quick development. It is useful,
but it is not the AWS-parity runtime because the processor is a long-running
container and the gateway may publish directly after the outbox write:

```text
DIRECT_PUBLISH_AFTER_OUTBOX=true
FSAMP_DEMO_RUNTIME=compose
```

The console reports the active `publishPath` and `runtimeMode` on the Publish Bridge step so screenshots do not overstate what was actually executed.

## Evidence

Each node shows local evidence where available:

| Node | Evidence source |
|---|---|
| LocalStack | `_localstack/health`, KMS `DescribeKey` |
| Cognito | User pool/client discovery and auth flow |
| Gateway | Upload response and correlation ID |
| Idempotency | DynamoDB query for the generated `X-Idempotency-Key` |
| S3 SSE-KMS | `HeadObject`, bucket encryption configuration |
| Gateway Outbox | DynamoDB query for `OUTBOX#FileUpload`, table stream status |
| Publish Bridge | Outbox status, DynamoDB Stream ARN, outbox-publisher Lambda and event-source mapping |
| SNS/SQS | File-events topic, processing-events topic, subscriptions, queue attributes |
| DLQ + Logs | Queue redrive policy, DLQ depth, CloudWatch/Logs LocalStack health, log correlation filters |
| Processor | Processor Lambda mapping and DynamoDB processing metadata |
| Result Outbox | DynamoDB query for `OUTBOX#FileProcessing` |

The log panel reads CloudWatch Logs in `terraform-local` mode and falls back to
Docker logs only in `compose` mode. It filters by `fileId`, `correlationId`,
`requestId`, `idempotencyKey`, object key and event/message IDs.

LocalStack Pro demonstrates the API-level behavior and is the primary repeatable evidence source for the thesis demo. It does not constitute formal FIPS validation or FedRAMP authorization. A short-lived real AWS run can supplement the evidence with CloudTrail, AWS Config, KMS, CloudWatch and managed-service control outputs, but it is not required for the LocalStack parity proof.
