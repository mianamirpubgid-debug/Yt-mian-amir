import { NextRequest, NextResponse } from "next/server";
import { store, finalPayload, pollOnce } from "@/lib/savenow";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = store.jobs.get(id);

  if (job && job.status === "ready") {
    return NextResponse.json({ success: true, status: "ready", progress: 100, ...finalPayload(job) });
  }
  if (job && job.status === "failed") {
    return NextResponse.json({
      success: false, status: "failed", progress: 100,
      error: job.error || "Download fail hua",
    });
  }
  if (job) {
    return NextResponse.json({
      success: true, status: job.status,
      progress: Math.floor(job.progress / 10),
      id: job.id, title: job.title, thumbnail: job.thumbnail,
    });
  }

  // Unknown id (server restart) -> seedha savenow se pucho
  try {
    const data = await pollOnce(id);
    const prog = data.progress ?? 0;
    if (prog >= 1000 && data.success && data.download_url) {
      return NextResponse.json({
        success: true, status: "ready", progress: 100, id,
        title: data.info?.title || "video",
        download_url: data.download_url,
      });
    }
    if (prog >= 1000) {
      return NextResponse.json({
        success: false, status: "failed", progress: 100,
        error: data.text || data.message || "Fail",
      });
    }
    return NextResponse.json({
      success: true, status: "processing", progress: Math.floor(prog / 10), id,
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Ye id nahi mila (server restart hua?)" },
      { status: 404 }
    );
  }
}
