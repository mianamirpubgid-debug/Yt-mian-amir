import { NextRequest, NextResponse } from "next/server";
import {
  normFormat,
  resolveVideoUrl,
  store,
  startNewJob,
  CACHE_TTL_MS,
} from "@/lib/savenow";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  try {
    const url = resolveVideoUrl(req.nextUrl.searchParams, req.nextUrl.search);
    const fmt = normFormat(req.nextUrl.searchParams.get("format"));
    const key = `${url}|${fmt}`;

    // 1) Cache hit -> turant ready
    const c = store.cache.get(key);
    if (c && Date.now() - c.ts < CACHE_TTL_MS) {
      const d = c.data;
      return NextResponse.json({
        success: true, status: "ready", progress: 100,
        id: d.id, title: d.title, thumbnail: d.thumbnail, cached: true,
      });
    }

    // 2) Pehle se chal raha hai?
    for (const j of store.jobs.values()) {
      if (j.url === url && j.format === fmt && j.status === "processing") {
        return NextResponse.json({
          success: true, status: "processing",
          progress: Math.floor(j.progress / 10),
          id: j.id, title: j.title, thumbnail: j.thumbnail,
        });
      }
    }

    // 3) Naya job
    const job = await startNewJob(url, fmt);
    return NextResponse.json({
      success: true, status: job.status, progress: 0,
      id: job.id, title: job.title, thumbnail: job.thumbnail,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 400 }
    );
  }
}
