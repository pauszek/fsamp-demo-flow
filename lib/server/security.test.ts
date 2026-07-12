import { afterEach, describe, expect, it, vi } from "vitest";

import { authorizeDemoRequest, sanitizeDiagnostic } from "@/lib/server/security";

function authorization(username = "demo-user", password = "demo-password") {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function request(url = "http://127.0.0.1:3000/api/runs", init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: authorization(),
      ...(init.headers ?? {}),
    },
  });
}

describe("demo request authorization", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts an authenticated loopback request", () => {
    vi.stubEnv("FSAMP_DEMO_USERNAME", "demo-user");
    vi.stubEnv("FSAMP_DEMO_PASSWORD", "demo-password");
    expect(authorizeDemoRequest(request())).toBeUndefined();
  });

  it("rejects remote hosts and invalid credentials", () => {
    vi.stubEnv("FSAMP_DEMO_USERNAME", "demo-user");
    vi.stubEnv("FSAMP_DEMO_PASSWORD", "demo-password");
    expect(authorizeDemoRequest(request("http://demo.example/api/runs"))?.status).toBe(404);
    expect(
      authorizeDemoRequest(
        request("http://127.0.0.1:3000/api/runs", {
          headers: { authorization: authorization("demo-user", "wrong") },
        }),
      )?.status,
    ).toBe(401);
  });

  it("requires a same-origin mutation guard", () => {
    vi.stubEnv("FSAMP_DEMO_USERNAME", "demo-user");
    vi.stubEnv("FSAMP_DEMO_PASSWORD", "demo-password");
    expect(authorizeDemoRequest(request(), { mutation: true })?.status).toBe(403);
    expect(
      authorizeDemoRequest(
        request("http://127.0.0.1:3000/api/runs", {
          method: "POST",
          headers: {
            authorization: authorization(),
            origin: "https://attacker.example",
            "x-fsamp-demo-request": "1",
          },
        }),
        { mutation: true },
      )?.status,
    ).toBe(403);
    expect(
      authorizeDemoRequest(
        request("http://127.0.0.1:3000/api/runs", {
          method: "POST",
          headers: {
            authorization: authorization(),
            origin: "http://127.0.0.1:3000",
            "sec-fetch-site": "same-origin",
            "x-fsamp-demo-request": "1",
          },
        }),
        { mutation: true },
      ),
    ).toBeUndefined();
  });

  it("redacts credentials and infrastructure identifiers", () => {
    const sanitized = sanitizeDiagnostic(
      "Bearer secret.token.value arn:aws:s3:::private 123456789012 password=hunter2",
    );
    expect(sanitized).not.toContain("secret.token.value");
    expect(sanitized).not.toContain("123456789012");
    expect(sanitized).not.toContain("hunter2");
  });
});
