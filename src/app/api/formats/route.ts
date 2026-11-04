import { NextResponse } from "next/server";
import { AUDIO_FORMATS, VIDEO_FORMATS } from "@/lib/savenow";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    audio: AUDIO_FORMATS,
    video: VIDEO_FORMATS,
    aliases: { mp4: "720p mp4", mp44k: "4k mp4", hd: "720p" },
    default: "720",
  });
}
