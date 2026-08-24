const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

type AuthorizationOptions = {
  mutation?: boolean;
};

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function configuredCredentials() {
  const username = process.env.FSAMP_DEMO_USERNAME?.trim() || "fsamp";
  const configuredPassword = process.env.FSAMP_DEMO_PASSWORD?.trim();
  const password =
    configuredPassword || (process.env.NODE_ENV === "production" ? "" : "local-demo-only");
  return { username, password };
}

function basicCredentials(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return undefined;

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function firstHeaderValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim();
}

function externallyVisibleUrl(request: Request) {
  const internalUrl = new URL(request.url);
  const forwardedProtocol = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const protocol = forwardedProtocol || internalUrl.protocol.slice(0, -1);
  if (protocol !== "http" && protocol !== "https") return undefined;

  const externalHost =
    request.headers.get("host")?.trim() ||
    firstHeaderValue(request.headers.get("x-forwarded-host")) ||
    internalUrl.host;
  if (!externalHost) return undefined;

  try {
    return new URL(`${protocol}://${externalHost}`);
  } catch {
    return undefined;
  }
}

function isSameOrigin(expected: URL, suppliedValue: string, fetchSite: string | null) {
  try {
    const supplied = new URL(suppliedValue);
    if (supplied.origin === expected.origin) return true;

    return (
      supplied.protocol === expected.protocol &&
      LOOPBACK_HOSTS.has(supplied.hostname.toLowerCase()) &&
      LOOPBACK_HOSTS.has(expected.hostname.toLowerCase()) &&
      (supplied.port === expected.port || fetchSite === "same-origin")
    );
  } catch {
    return false;
  }
}

function response(status: number, message: string, authenticate = false) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (authenticate) {
    headers.set("WWW-Authenticate", 'Basic realm="FSAMP local demo", charset="UTF-8"');
  }
  return Response.json({ error: message }, { status, headers });
}

export function authorizeDemoRequest(
  request: Request,
  options: AuthorizationOptions = {},
): Response | undefined {
  const url = externallyVisibleUrl(request);
  if (!url) return response(404, "Not Found");
  if (
    process.env.FSAMP_DEMO_ALLOW_REMOTE !== "true" &&
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return response(404, "Not Found");
  }

  const expected = configuredCredentials();
  if (!expected.password) {
    return response(503, "Demo authentication is not configured");
  }

  const supplied = basicCredentials(request);
  if (
    !supplied ||
    !constantTimeEqual(supplied.username, expected.username) ||
    !constantTimeEqual(supplied.password, expected.password)
  ) {
    return response(401, "Authentication required", true);
  }

  if (options.mutation) {
    if (request.headers.get("x-fsamp-demo-request") !== "1") {
      return response(403, "Missing demo request guard");
    }

    const fetchSite = request.headers.get("sec-fetch-site");
    const origin = request.headers.get("origin");
    if (origin && !isSameOrigin(url, origin, fetchSite)) {
      return response(403, "Cross-origin request rejected");
    }

    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return response(403, "Cross-site request rejected");
    }
  }

  return undefined;
}

export function sanitizeDiagnostic(value: unknown, maxLength = 500) {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<access-key-redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<jwt-redacted>")
    .replace(/arn:aws[A-Za-z0-9\-:_/]+/g, "<arn-redacted>")
    .replace(/\b\d{12}\b/g, "<account-redacted>")
    .replace(/(password|secret|token|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=<redacted>")
    .slice(0, maxLength);
}
