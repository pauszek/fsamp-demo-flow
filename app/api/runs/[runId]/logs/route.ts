import { collectLogs } from "@/lib/server/logs";
import { getRun } from "@/lib/server/runs";
import { authorizeDemoRequest } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;
  const { runId } = await params;
  const run = await getRun(runId);

  if (!run) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json(await collectLogs(run));
}
