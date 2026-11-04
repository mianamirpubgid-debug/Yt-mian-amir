import { NextRequest } from "next/server";
import {
  checkUrl,
  normFormat,
  getResult,
  invalidateCache,
  EXT,
  safeName,
  UA,
} from "@/lib/savenow";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RETRY_STATUS = new Set([403, 404, 410, 429]);

/* Upstream (savenow) Range support NAHI karta — hamesha 200 + poora file deta hai.
   Is liye hum khud Range emulate karte hain: skip/slice + 206 responses.
   Total size pehli poori stream par seekh kar cache ho jata hai. */
const g = globalThis as unknown as { __snSizeCache?: Map<string, number> };
const sizeCache: Map<string, number> = (g.__snSizeCache ??= new Map());

async function fetchUpstream(downloadUrl: string) {
  return fetch(downloadUrl, {
    headers: {
      "User-Agent": UA,
      Referer: "https://p.savenow.to/",
      Accept: "*/*",
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(280_000),
  });
}

function contentDisposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const type = inline ? "inline" : "attachment";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream se start..endIncl (inclusive) ka hissa nikalta hai, baqi cancel. */
function sliceStream(
  body: ReadableStream<Uint8Array>,
  start: number,
  endIncl: number | null
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let pos = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          controller.close();
          return;
        }
        const chunkStart = pos;
        const chunkEnd = pos + value.length - 1;
        pos += value.length;
        let s = 0;
        let e = value.length;
        if (chunkStart < start) s = Math.min(start - chunkStart, value.length);
        if (endIncl !== null && chunkEnd > endIncl) e = Math.max(0, endIncl + 1 - chunkStart);
        if (s < e) controller.enqueue(value.subarray(s, e));
        if (endIncl !== null && chunkEnd >= endIncl) {
          finished = true;
          controller.close();
          reader.cancel().catch(() => {});
          return;
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/** Byte count karta hai; natural end par sizeCache mein likh deta hai (cancel par nahi). */
function countingStream(
  body: ReadableStream<Uint8Array>,
  key: string
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let count = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        sizeCache.set(key, count);
        controller.close();
        return;
      }
      count += value.length;
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const url = checkUrl(sp.get("url"));
    const fmt = normFormat(sp.get("format"));
    const customName = sp.get("filename");
    const inline = sp.get("inline") === "1";
    const key = `${url}|${fmt}`;

    // Client Range parse: bytes=X-Y (dono optional)
    const rm = (req.headers.get("range") || "").match(/bytes=(\d*)-(\d*)/);
    let start = 0;
    let endIncl: number | null = null;
    const hasRange = !!rm && (rm[1] !== "" || rm[2] !== "");
    if (hasRange && rm) {
      if (rm[1] !== "") start = parseInt(rm[1], 10);
      if (rm[2] !== "") endIncl = parseInt(rm[2], 10);
    }

    // Pehli koshish: cache/inflight se
    let result = await getResult(url, fmt);
    if (!result.download_url) {
      return Response.json({ success: false, error: "download_url nahi mila" }, { status: 502 });
    }

    // Upstream ko hamesha poora stream mangte hain (wo Range follow hi nahi karta)
    let upstream = await fetchUpstream(result.download_url);

    // Stale/dead link -> cache clear, FRESH link, dobara
    if (RETRY_STATUS.has(upstream.status)) {
      invalidateCache(url, fmt);
      result = await getResult(url, fmt);
      if (!result.download_url) {
        return Response.json(
          { success: false, error: "fresh download_url bhi nahi mila" },
          { status: 502 }
        );
      }
      upstream = await fetchUpstream(result.download_url);
    }

    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { success: false, error: `Upstream HTTP ${upstream.status}` },
        { status: 502 }
      );
    }

    const ext = EXT[fmt] || "bin";
    const name = customName || safeName(result.title, ext);

    const headers = new Headers();
    headers.set(
      "Content-Type",
      upstream.headers.get("content-type") ||
        (ext === "mp4" ? "video/mp4" : "application/octet-stream")
    );
    headers.set("Content-Disposition", contentDisposition(name, inline));
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");

    const upstreamLen = upstream.headers.get("content-length");
    const knownSize = sizeCache.get(key) ?? (upstreamLen ? parseInt(upstreamLen, 10) : null);
    const total = knownSize ?? null;

    if (!hasRange) {
      // 200 — poori file; stream ke khatam hone par size seekh lo
      if (total) headers.set("Content-Length", String(total));
      return new Response(countingStream(upstream.body, key), { status: 200, headers });
    }

    // Range request
    if (total !== null && start >= total) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const effEnd = endIncl !== null ? endIncl : total !== null ? total - 1 : null;
    headers.set("Content-Range", `bytes ${start}-${effEnd ?? ""}/${total ?? "*"}`);
    const cl = effEnd !== null ? effEnd - start + 1 : null;
    if (cl !== null) headers.set("Content-Length", String(cl));
    return new Response(sliceStream(upstream.body, start, effEnd), { status: 206, headers });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 502 }
    );
  }
}
