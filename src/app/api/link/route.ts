import { NextRequest } from "next/server";
import {
  checkUrl,
  normFormat,
  getResult,
  invalidateCache,
  type FinalPayload,
} from "@/lib/savenow";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function htmlView(r: FinalPayload, fileUrl: string, playUrl: string, raw: string): string {
  const isVideo = !["mp3", "m4a", "aac", "flac", "opus", "ogg", "wav", "webm"].includes(r.format);
  const player = isVideo
    ? `<video controls preload="metadata" playsinline poster="${esc(r.thumbnail)}" style="width:100%;border-radius:12px;background:#000;aspect-ratio:16/9" data-src="${esc(playUrl)}"></video>`
    : r.thumbnail
      ? `<img src="${esc(r.thumbnail)}" style="width:100%;border-radius:12px" alt="">`
      : "";
  const audioTag = isVideo
    ? ""
    : `<audio controls preload="metadata" data-src="${esc(playUrl)}" style="width:100%;margin:8px 0"></audio>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.title)}</title>
<style>
body{margin:0;background:#0f1220;color:#e2e8f0;font:15px/1.5 system-ui,-apple-system,sans-serif;display:flex;justify-content:center;padding:16px}
main{width:100%;max-width:560px}
h1{font-size:17px;margin:14px 0 6px}
a.btn{display:flex;align-items:center;justify-content:center;gap:8px;height:48px;border-radius:10px;font-weight:700;text-decoration:none;margin-top:10px}
.btn.dl{background:#34d399;color:#08130d}
.btn.pl{background:#262c4a;color:#99f6e4}
code,pre{font-family:ui-monospace,monospace}
pre{background:#10131f;color:#6ee7b7;font-size:11px;border-radius:10px;padding:12px;overflow:auto;max-height:260px}
.note{color:#64748b;font-size:12px;margin-top:10px}
</style></head><body><main>
${player}
${audioTag}
<h1>${esc(r.title)}</h1>
<p style="margin:0;color:#34d399;font-size:13px">Format: ${esc(r.format)} · Ready ✓</p>
<a class="btn dl" href="${esc(fileUrl)}">⬇️ Download Karo</a>
<a class="btn pl" href="${esc(playUrl)}" target="_blank">▶ Naye Tab Mein Chalao</a>
<p class="note">Ye links isi domain se ban rahe hain — kisi bhi device/network par chalenge. (Savenow ka raw link IP-locked hota hai, is liye hamara proxy use hota hai.)</p>
<details><summary style="cursor:pointer;color:#5eead4;font-size:13px;margin-top:10px">Raw JSON dekho</summary><pre>${esc(raw)}</pre></details>
</main>
<script>
// src ko JS se lagate hain taake browser ka apna origin use ho (server ko public domain nahi pata)
document.querySelectorAll("[data-src]").forEach(function(el){ el.src = el.getAttribute("data-src"); });
</script>
</body></html>`;
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  try {
    const url = checkUrl(req.nextUrl.searchParams.get("url"));
    const fmt = normFormat(req.nextUrl.searchParams.get("format"));
    // refresh=1 -> cache khiis kar ke FRESH job (savenow kabhi kabhi broken file deta hai)
    if (req.nextUrl.searchParams.get("refresh") === "1") {
      invalidateCache(url, fmt);
    }
    const result = await getResult(url, fmt);
    const enc = encodeURIComponent;

    // Relative URLs — same-origin se hamesha sahi resolve hote hain
    const fileUrl = `/api/file?url=${enc(url)}&format=${fmt}`;
    const playUrl = `${fileUrl}&inline=1`;

    const payload = {
      ...result,
      // download_url relative hai — apne domain ke sath jodo:
      // https://<apna-domain>/api/file?url=...&format=...
      // (savenow ka raw IP-locked link ab upstream_url mein hai)
      download_url: fileUrl,
      play_url: playUrl,
      upstream_url: result.download_url,
      // 1 sec se kam laga to cache se aya
      cached: Date.now() - started < 1000,
      seconds_taken: Math.round((Date.now() - started) / 100) / 10,
    };

    // Browser se khola (Accept: text/html) -> pretty clickable page
    const accept = req.headers.get("accept") || "";
    if (accept.includes("text/html")) {
      const raw = JSON.stringify(payload, null, 2);
      return new Response(htmlView(result, fileUrl, playUrl, raw), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 502 }
    );
  }
}
