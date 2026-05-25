# FSAMP Local Flow Console

Local-only Next.js console for visualizing the FSAMP event-driven file-processing flow.

The console is not part of the production security boundary. It is a thesis/demo tool that observes the local LocalStack environment and presents evidence for each step of the flow:

```text
Upload -> Gateway -> S3 SSE-KMS -> Gateway Outbox -> SNS/SQS -> Processor -> DynamoDB -> Result Outbox
```

## Stack

| Layer | Technology |
|---|---|
| UI | Next.js, React, TypeScript, React Flow |
| Local backend | Next.js route handlers |
| AWS simulation | LocalStack through AWS SDK v3 |
| Runtime evidence | Gateway API, S3, KMS, SNS, SQS, DynamoDB, optional Docker logs |

## Local Run

The quickest path is the Makefile:

```bash
cp .env.example .env.local
# Fill LOCALSTACK_AUTH_TOKEN in .env.local
make demo
```

This starts the LocalStack e2e stack and then runs the Next.js console.

Useful targets:

| Target | Purpose |
|---|---|
| `make demo` | Build local images, start Docker stack and run the console |
| `make stack` | Build local images and start LocalStack, gateway and processor |
| `make images` | Build gateway and processor images from local repos |
| `make app` | Run only the Next.js console |
| `make e2e` | Run the existing FSAMP e2e test container |
| `make health` | Check LocalStack, gateway and processor |
| `make logs` | Tail LocalStack, gateway and processor logs |
| `make stop` | Stop the Docker stack |
| `make reset` | Stop stack, remove volumes and clear `.demo-runs` |

Manual commands are still available:

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

## Evidence

Each node shows local evidence where available:

| Node | Evidence source |
|---|---|
| LocalStack | `_localstack/health`, KMS `DescribeKey` |
| Cognito | User pool/client discovery and auth flow |
| Gateway | Upload response and correlation ID |
| S3 SSE-KMS | `HeadObject`, bucket encryption configuration |
| Gateway Outbox | DynamoDB query for `OUTBOX#FileUpload` |
| SNS/SQS | Topic attributes, subscriptions, queue attributes |
| Processor | DynamoDB processing metadata |
| Result Outbox | DynamoDB query for `OUTBOX#FileProcessing` |

LocalStack demonstrates the API-level behavior. It does not constitute formal FIPS validation. Production AWS evidence should come from real AWS configuration, CloudTrail, Config, KMS, and service control outputs.
