import { collectEvidence } from "@/lib/server/evidence";
import { getRun, saveRun } from "@/lib/server/runs";
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

  const observed = await collectEvidence(run);
  const saved = await saveRun(observed);
  return Response.json(saved);
}
