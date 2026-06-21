import { createHash, randomUUID } from "node:crypto";

import { DescribeKeyCommand } from "@aws-sdk/client-kms";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { PublishCommand } from "@aws-sdk/client-sns";

import type { DirectEvent } from "@/lib/flow/types";
import { kmsClient, s3Client, snsClient } from "@/lib/server/aws";
import { getConfig } from "@/lib/server/config";

export async function publishDirectFileEvent(file: File): Promise<DirectEvent> {
  const config = getConfig();
  const fileId = randomUUID();
  const eventId = randomUUID();
  const correlationId = randomUUID();
  const body = Buffer.from(await file.arrayBuffer());
  const checksumSha256 = createHash("sha256").update(body).digest("hex");
  const objectKey = `demo-events/${new Date().toISOString().slice(0, 10)}/${fileId}-${file.name}`;

  const key = await kmsClient().send(
    new DescribeKeyCommand({
      KeyId: config.kmsKeyId,
    }),
  );
  const kmsKeyId = key.KeyMetadata?.Arn ?? config.kmsKeyId;

  await s3Client().send(
    new PutObjectCommand({
      Bucket: config.s3BucketName,
      Key: objectKey,
      Body: body,
      ContentType: file.type || "text/plain",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: kmsKeyId,
      Metadata: {
        "correlation-id": correlationId,
        "original-filename": file.name,
        "checksum-sha256": checksumSha256,
      },
    }),
  );

  const event = {
    schemaVersion: "1.1.2",
    fileId,
    eventId,
    correlationId,
    timestamp: new Date().toISOString(),
    source: "fsamp-gateway",
    eventType: "FILE_UPLOADED",
    fileMetadata: {
      originalFilename: file.name,
      fileSizeBytes: body.length,
      mimeType: file.type || "text/plain",
      checksumSHA256: checksumSha256,
    },
    storageLocation: {
      bucketName: config.s3BucketName,
      objectKey,
      region: config.awsRegion,
    },
    securityContext: {
      isEncrypted: true,
      encryptionAlgorithm: "AES/GCM/NoPadding",
      kmsKeyId,
    },
  };

  const response = await snsClient().send(
    new PublishCommand({
      TopicArn: config.fileEventsTopicArn,
      Message: JSON.stringify(event),
      MessageAttributes: {
        eventType: {
          DataType: "String",
          StringValue: "FILE_UPLOADED",
        },
        source: {
          DataType: "String",
          StringValue: "fsamp-gateway",
        },
      },
    }),
  );

  return {
    eventId,
    fileId,
    correlationId,
    objectKey,
    bucketName: config.s3BucketName,
    topicArn: config.fileEventsTopicArn,
    checksumSha256,
    messageId: response.MessageId,
  };
}
