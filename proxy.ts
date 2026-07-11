import { type NextRequest, NextResponse } from "next/server";

import { authorizeDemoRequest } from "@/lib/server/security";

export function proxy(request: NextRequest) {
  const denied = authorizeDemoRequest(request, {
    mutation: !["GET", "HEAD", "OPTIONS"].includes(request.method),
  });
  if (denied) return denied;

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
