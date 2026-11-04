import { NextRequest } from "next/server";
import {
  checkUrl,
  normFormat,
  getResult,
  invalidateCache,
  AUDIO_FORMATS,
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

/** Stream se start..endIncl (inclusive) ka hissa nikalta hai, baqi cancel.
    pull() har call par SIRF ek chunk read karke return karta hai — kabhi bhi
    andar loop nahi karte, warna Next.js/Node stream adapter block ho jata hai. */
function sliceStream(
  body: ReadableStream<Uint8Array>,
  start: number,
  endIncl: number | null,
  sizeKey?: string
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
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        // Natural EOF tak pohnche (unbounded range) -> total size seekh lo
        if (endIncl === null && sizeKey && pos > 0) sizeCache.set(sizeKey, pos);
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
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/** MP4 faststart probe: top-level boxes (ftyp/moov/mdat) parse kar ke EXACT total
    file size nikalta hai — sirf pehle ~1MB parhne se. Sath hi consumed bytes ko
    wapas stream karne ke liye concat stream bhi return karta hai (koi byte zaya nahi).
    Parse na ho (mp3/webm/etc) to total=null — caller 200 fallback karega. */
const MP4_PROBE_MAX = 1 << 20; // 1MB

function probeMp4Size(body: ReadableStream<Uint8Array>): Promise<{
  total: number | null;
  durationSec: number | null;
  stream: ReadableStream<Uint8Array>;
}> {
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  let bufferedLen = 0;

  /** Top-level boxes walk; moov ke andar mvhd se duration bhi nikalta hai. */
  function parseMeta(
    buf: Uint8Array,
    len: number
  ): { total: number | null; durationSec: number | null } {
    let durationSec: number | null = null;
    let pos = 0;
    for (;;) {
      if (pos + 8 > len) return { total: null, durationSec };
      const dv = new DataView(buf.buffer, buf.byteOffset + pos, len - pos);
      let size = dv.getUint32(0);
      const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
      let hdr = 8;
      if (size === 1) {
        // 64-bit largesize
        if (pos + 16 > len) return { total: null, durationSec };
        const dv64 = new DataView(buf.buffer, buf.byteOffset + pos + 8, 8);
        size = dv64.getUint32(0) * 4294967296 + dv64.getUint32(4);
        hdr = 16;
      }
      if (size === 0 || size < hdr) return { total: null, durationSec }; // EOF-till / corrupt
      if (type === "moov" && pos + size <= len) {
        // moov ke bachon mein mvhd dhoondo (v0 + v1 dono layouts)
        const end = pos + size;
        let c = pos + 8;
        while (c + 8 <= end) {
          const cv = new DataView(buf.buffer, buf.byteOffset + c, end - c);
          const csize = cv.getUint32(0);
          const ctype = String.fromCharCode(
            buf[c + 4],
            buf[c + 5],
            buf[c + 6],
            buf[c + 7]
          );
          if (ctype === "mvhd" && csize >= 32) {
            const version = buf[c + 8];
            let timescale = 0;
            let duration = 0;
            if (version === 1) {
              // v1: creation(8)+modification(8)+timescale(4)+duration(8)
              if (c + 40 <= end) {
                const dvts = new DataView(buf.buffer, buf.byteOffset + c + 28, 4);
                timescale = dvts.getUint32(0);
                const dvd = new DataView(buf.buffer, buf.byteOffset + c + 32, 8);
                duration = dvd.getUint32(0) * 4294967296 + dvd.getUint32(4);
              }
            } else {
              // v0: creation(4)+modification(4)+timescale(4)+duration(4)
              if (c + 28 <= end) {
                const dvts = new DataView(buf.buffer, buf.byteOffset + c + 20, 4);
                timescale = dvts.getUint32(0);
                const dvd = new DataView(buf.buffer, buf.byteOffset + c + 24, 4);
                duration = dvd.getUint32(0);
              }
            }
            if (timescale > 0) durationSec = duration / timescale;
            break;
          }
          if (csize < 8) break;
          c += csize;
        }
      }
      if (type === "mdat") return { total: pos + size, durationSec };
      pos += size;
      if (pos > len) return { total: null, durationSec }; // box buffer se bahar
    }
  }

  async function run(): Promise<{
    total: number | null;
    durationSec: number | null;
    stream: ReadableStream<Uint8Array>;
  }> {
    let total: number | null = null;
    let durationSec: number | null = null;
    try {
      while (bufferedLen < MP4_PROBE_MAX) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered.push(value);
        bufferedLen += value.length;
        if (bufferedLen >= 64) {
          const flat = new Uint8Array(bufferedLen);
          let off = 0;
          for (const c of buffered) {
            flat.set(c, off);
            off += c.length;
          }
          const meta = parseMeta(flat, bufferedLen);
          if (meta.total !== null && meta.total > 0) {
            total = meta.total;
            durationSec = meta.durationSec;
            break;
          }
        }
      }
    } catch {
      total = null;
    }

    // Consumed bytes ko wapas stream mein daal do (phir live reader se aage)
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (buffered.length > 0) {
          controller.enqueue(buffered.shift()!);
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch {
          controller.close();
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });
    return { total, durationSec, stream };
  }

  return run();
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
    /* sizeCache ka key = upstream download_url (har job ka apna) — url|fmt nahi,
       warna stale link expire ho kar naya job aaye to purana (ghalat) size reh jata hai. */

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
    let sizeKey = result.download_url;

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
      sizeKey = result.download_url;
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
    const knownSize = sizeCache.get(sizeKey) ?? (upstreamLen ? parseInt(upstreamLen, 10) : null);
    let total = knownSize ?? null;

    console.log(
      "[file]",
      JSON.stringify({
        range: req.headers.get("range"),
        ua: (req.headers.get("user-agent") || "").slice(0, 50),
        upStatus: upstream.status,
        upCT: upstream.headers.get("content-type"),
        upCL: upstreamLen,
        upCE: upstream.headers.get("content-encoding"),
        total,
      })
    );

    // Har request par (Range ho ya na ho) agar size maloom nahi to probe karo:
    // faststart MP4 ke top-level boxes se EXACT total + mvhd se duration milti hai.
    // Video duration < 4s => savenow ne tuta hua transcode diya => fresh job try karo.
    let stream = upstream.body;
    if (total === null) {
      const isVideoFmt = !AUDIO_FORMATS.includes(fmt);
      for (let attempt = 0; ; attempt++) {
        const probe = await probeMp4Size(stream);
        stream = probe.stream;
        if (probe.total === null) {
          // MP4 parse nahi hua (mp3/webm/etc) -> 200 full-content, size EOF par seekhi jayegi
          console.log("[file] probe FAIL -> 200 fallback");
          return new Response(countingStream(stream, sizeKey), { status: 200, headers });
        }
        total = probe.total;
        sizeCache.set(sizeKey, total);
        const broken =
          isVideoFmt && probe.durationSec !== null && probe.durationSec < 4 && attempt < 1;
        console.log(
          `[file] probe OK total=${total} dur=${
            probe.durationSec !== null ? probe.durationSec.toFixed(2) : "?"
          }s attempt=${attempt}${broken ? " -> BROKEN TRANSCODE, refresh" : ""}`
        );
        if (!broken) break;
        // Cache khiis karo, naya job lo, dobara probe
        invalidateCache(url, fmt);
        const fresh = await getResult(url, fmt);
        if (!fresh.download_url || fresh.download_url === result.download_url) break;
        result = fresh;
        sizeKey = result.download_url;
        upstream = await fetchUpstream(result.download_url);
        if (!upstream.ok || !upstream.body) {
          return Response.json(
            { success: false, error: `Upstream HTTP ${upstream.status}` },
            { status: 502 }
          );
        }
        stream = upstream.body;
      }
    }

    if (!hasRange) {
      // 200 — poori file
      if (total) headers.set("Content-Length", String(total));
      return new Response(countingStream(stream, sizeKey), { status: 200, headers });
    }

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
    return new Response(sliceStream(stream, start, effEnd, sizeKey), { status: 206, headers });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 502 }
    );
  }
}
