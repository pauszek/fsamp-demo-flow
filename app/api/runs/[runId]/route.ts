import { collectEvidence } from "@/lib/server/evidence";
import { getRun, saveRun } from "@/lib/server/runs";

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

  const observed = await collectEvidence(run);
  const saved = await saveRun(observed);
  return Response.json(saved);
}
