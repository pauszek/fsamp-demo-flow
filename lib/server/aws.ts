import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";

import { getConfig } from "@/lib/server/config";

function baseClientConfig() {
  const config = getConfig();
  return {
    region: config.awsRegion,
    endpoint: config.awsEndpointUrl,
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    },
  };
}

export function s3Client() {
  return new S3Client({
    ...baseClientConfig(),
    forcePathStyle: true,
  });
}

export function cloudWatchLogsClient() {
  return new CloudWatchLogsClient(baseClientConfig());
}

export function dynamoClient() {
  return new DynamoDBClient(baseClientConfig());
}

export function sqsClient() {
  return new SQSClient(baseClientConfig());
}

export function snsClient() {
  return new SNSClient(baseClientConfig());
}

export function kmsClient() {
  return new KMSClient(baseClientConfig());
}

export function lambdaClient() {
  return new LambdaClient(baseClientConfig());
}

export function cognitoClient() {
  return new CognitoIdentityProviderClient(baseClientConfig());
}
