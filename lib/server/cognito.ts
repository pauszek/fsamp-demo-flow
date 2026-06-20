import {
  AdminInitiateAuthCommand,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { cognitoClient } from "@/lib/server/aws";
import { getConfig } from "@/lib/server/config";

type CognitoIds = {
  userPoolId: string;
  clientId: string;
};

let cachedIds: CognitoIds | undefined;
let cachedToken: { token: string; expiresAt: number } | undefined;

export async function discoverCognitoIds(): Promise<CognitoIds> {
  if (cachedIds) return cachedIds;

  const envPoolId = process.env.COGNITO_USER_POOL_ID;
  const envClientId = process.env.COGNITO_CLIENT_ID;
  if (envPoolId && envClientId) {
    cachedIds = { userPoolId: envPoolId, clientId: envClientId };
    return cachedIds;
  }

  const client = cognitoClient();
  const pools = await client.send(new ListUserPoolsCommand({ MaxResults: 10 }));
  const pool = pools.UserPools?.find((candidate) =>
    candidate.Name?.toLowerCase().includes("fsamp"),
  );

  if (!pool?.Id) {
    throw new Error("FSAMP Cognito user pool not found in LocalStack");
  }

  const clients = await client.send(
    new ListUserPoolClientsCommand({
      UserPoolId: pool.Id,
      MaxResults: 10,
    }),
  );
  const userPoolClient = clients.UserPoolClients?.[0];

  if (!userPoolClient?.ClientId) {
    throw new Error("FSAMP Cognito app client not found in LocalStack");
  }

  cachedIds = {
    userPoolId: pool.Id,
    clientId: userPoolClient.ClientId,
  };
  return cachedIds;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 300_000) {
    return cachedToken.token;
  }

  const config = getConfig();
  const ids = await discoverCognitoIds();
  const client = cognitoClient();

  const response = await client.send(
    new AdminInitiateAuthCommand({
      UserPoolId: ids.userPoolId,
      ClientId: ids.clientId,
      AuthFlow: "ADMIN_NO_SRP_AUTH",
      AuthParameters: {
        USERNAME: config.testUser,
        PASSWORD: config.testPassword,
      },
    }),
  );

  const authResult = response.AuthenticationResult;
  const token = authResult?.IdToken ?? authResult?.AccessToken;
  if (!authResult || !token) {
    throw new Error("Cognito authentication did not return a gateway token");
  }

  cachedToken = {
    token,
    expiresAt: Date.now() + (authResult.ExpiresIn ?? 3600) * 1000,
  };

  return token;
}
