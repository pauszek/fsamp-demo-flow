import { collectLogs } from "@/lib/server/logs";
import { getRun } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const run = await getRun(runId);

  if (!run) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json(await collectLogs(run));
}
