import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@/lib/server/aws", () => ({
  cognitoClient: () => ({ send }),
}));

vi.mock("@/lib/server/config", () => ({
  getConfig: () => ({
    testUser: "demo-user",
    testPassword: "demo-password",
  }),
}));

async function loadGetAccessToken() {
  vi.stubEnv("COGNITO_USER_POOL_ID", "test-pool");
  vi.stubEnv("COGNITO_CLIENT_ID", "test-client");
  return (await import("@/lib/server/cognito")).getAccessToken;
}

describe("cognito access token", () => {
  beforeEach(() => {
    vi.resetModules();
    send.mockReset();
  });

  it("uses the scoped access token instead of the ID token", async () => {
    send.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: "scoped-access-token",
        IdToken: "identity-token",
        ExpiresIn: 3600,
      },
    });
    const getAccessToken = await loadGetAccessToken();

    await expect(getAccessToken()).resolves.toBe("scoped-access-token");
  });

  it("fails closed when Cognito does not return an access token", async () => {
    send.mockResolvedValue({
      AuthenticationResult: {
        IdToken: "identity-token",
        ExpiresIn: 3600,
      },
    });
    const getAccessToken = await loadGetAccessToken();

    await expect(getAccessToken()).rejects.toThrow(
      "Cognito authentication did not return an access token",
    );
  });
});
