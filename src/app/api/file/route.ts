import { NextRequest, after } from "next/server";
import {
  normFormat,
  getResult,
  invalidateCache,
  resolveVideoUrl,
  AUDIO_FORMATS,
  EXT,
  safeName,
  UA,
} from "@/lib/savenow";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RETRY_STATUS = new Set([403, 404, 410, 429]);
const MP4_PROBE_MAX = 1 << 20; // 1MB probe
const SOURCE_MEM_CAP = 96 << 20; // sab sources combined cap
const SOURCE_HARD_CAP = 256 << 20; // ek file ki max retain

/* ---------------- Upstream fetch ---------------- */

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

/* ---------------- Source manager ----------------
   Ek job (download_url) ka upstream stream SIRF EK dafa fetch hota hai.
   Chunks memory mein jama hote rehte hain; har subscriber (video start,
   seek, download, dusra user) unhi chunks se serve hota hai. Client request
   cancel kar de to bhi fill chalta rehta hai — agli range request INSTANT
   milti hai (20s ka upstream TTFB sirf pehli dafa lagta hai). */

type ProbeMeta = { total: number | null; durationSec: number | null; isFmp4: boolean };

type Source = {
  key: string;
  chunks: Uint8Array[];
  offsets: number[]; // offsets[i] = pehli i chunks ka byte total
  bytesSeen: number;
  total: number | null; // EOF par set
  probed: ProbeMeta | null;
  probePromise: Promise<ProbeMeta> | null;
  fillPromise: Promise<void> | null;
  done: boolean;
  err: Error | null;
  waiters: Set<() => void>;
};

const g = globalThis as unknown as {
  __snSources?: Map<string, Source>;
  __snSrcInflight?: Map<string, Promise<Source>>;
};
const sources: Map<string, Source> = (g.__snSources ??= new Map());
const srcInflight: Map<string, Promise<Source>> = (g.__snSrcInflight ??= new Map());

function wake(src: Source) {
  for (const w of src.waiters) w();
  src.waiters.clear();
}

function sourcesMem(): number {
  let n = 0;
  for (const s of sources.values()) n += s.bytesSeen;
  return n;
}

function evict(keepKey: string) {
  for (const k of [...sources.keys()]) {
    if (sourcesMem() <= SOURCE_MEM_CAP && sources.size <= 6) break;
    if (k === keepKey) continue;
    const s = sources.get(k);
    if (s && s.done && s.waiters.size === 0) sources.delete(k);
    else break;
  }
}

async function ensureSource(key: string, getFresh: () => Promise<string>): Promise<Source> {
  const existing = sources.get(key);
  if (existing) return existing;
  const running = srcInflight.get(key);
  if (running) return running;
  const p = (async (): Promise<Source> => {
    const src: Source = {
      key,
      chunks: [],
      offsets: [0],
      bytesSeen: 0,
      total: null,
      probed: null,
      probePromise: null,
      fillPromise: null,
      done: false,
      err: null,
      waiters: new Set(),
    };
    sources.set(key, src);
    srcInflight.delete(key);
    console.log(`[src] fill start ${key.slice(-28)}`);
    src.fillPromise = (async () => {
      try {
        let upstream = await fetchUpstream(key);
        if (RETRY_STATUS.has(upstream.status)) {
          const fresh = await getFresh();
          if (!fresh || fresh === key) {
            throw new Error(`Upstream HTTP ${upstream.status}`);
          }
          // is key ka source bogus — hatao; caller fresh key se dobara aayega
          sources.delete(key);
          src.err = new Error("STALE");
          return;
        }
        if (!upstream.ok || !upstream.body) {
          throw new Error(`Upstream HTTP ${upstream.status}`);
        }
        const reader = upstream.body.getReader();
        for (;;) {
          // 45s stall watchdog: upstream atak jaye to jo mila usi par EOF qarar do
          let tid: ReturnType<typeof setTimeout> | undefined;
          const timer = new Promise<"STALL">((res) => {
            tid = setTimeout(() => res("STALL"), 45_000);
          });
          const result = (await Promise.race([reader.read(), timer])) as
            | { done: boolean; value?: Uint8Array }
            | "STALL";
          if (tid) clearTimeout(tid);
          if (result === "STALL") {
            console.log(`[src] fill STALL ${key.slice(-28)} @ ${src.bytesSeen} -> EOF qarar`);
            reader.cancel().catch(() => {});
            src.total = src.bytesSeen;
            break;
          }
          const { done, value } = result;
          if (done) {
            src.total = src.bytesSeen;
            break;
          }
          src.chunks.push(value);
          src.bytesSeen += value.length;
          src.offsets.push(src.bytesSeen);
          wake(src);
          if (src.bytesSeen > SOURCE_HARD_CAP) {
            src.total = src.bytesSeen;
            break;
          }
          evict(src.key);
        }
        console.log(`[src] fill EOF ${key.slice(-28)} = ${src.bytesSeen}`);
      } catch (e) {
        src.err = e instanceof Error ? e : new Error("fill fail");
        console.log(`[src] fill ERR ${key.slice(-28)}: ${src.err.message}`);
      } finally {
        src.done = true;
        wake(src);
      }
    })(); // detached — request khatam ho to bhi fill chalta hai
    return src;
  })();
  srcInflight.set(key, p);
  return p;
}

/** src ke accumulated chunks se pos par chunk (subarray pos se aage). */
function chunkAt(src: Source, pos: number): Uint8Array | null {
  if (pos >= src.bytesSeen) return null;
  let i = 1;
  while (i < src.offsets.length && src.offsets[i] <= pos) i++;
  const chunkStart = src.offsets[i - 1];
  return src.chunks[i - 1].subarray(pos - chunkStart);
}

/** pos se agla chunk (ya EOF par null). Naya data aane ka intezar karta hai. */
async function readFrom(src: Source, pos: number): Promise<Uint8Array | null> {
  for (;;) {
    if (src.err) {
      if (src.err.message === "STALE") throw src.err;
      throw src.err;
    }
    if (src.total !== null && pos >= src.total) return null;
    if (pos < src.bytesSeen) return chunkAt(src, pos);
    if (src.done) return null;
    await new Promise<void>((res) => src.waiters.add(res));
  }
}

/** [start..endIncl] ka response stream — memory chunks se, kabhi bhi upstream
    dobara fetch NAHI karta. Client cancel kare to source fill jaari rehta hai. */
function streamFrom(
  src: Source,
  start: number,
  endIncl: number | null
): ReadableStream<Uint8Array> {
  let pos = start;
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      try {
        const chunk = await readFrom(src, pos);
        if (!chunk) {
          closed = true;
          controller.close();
          return;
        }
        let out = chunk;
        if (endIncl !== null && pos + out.length - 1 > endIncl) {
          out = out.subarray(0, endIncl + 1 - pos);
        }
        pos += out.length;
        if (endIncl !== null && pos > endIncl) closed = true;
        controller.enqueue(out);
        if (closed) controller.close();
      } catch (e) {
        closed = true;
        controller.error(e instanceof Error ? e : new Error("stream fail"));
      }
    },
    cancel() {
      // jaan boojh kar khali — source fill rokte nahi
    },
  });
}

/* ---------------- MP4 probe ---------------- */

/** Top-level boxes walk; moov ke andar mvhd/mehd se duration aur mvex se
    fMP4 detection (fragmented files mein mdat-based total JHOOTA hota hai). */
function parseMeta(buf: Uint8Array, len: number): ProbeMeta {
  let durationSec: number | null = null;
  let isFmp4 = false;
  let pos = 0;
  for (;;) {
    if (pos + 8 > len) return { total: null, durationSec, isFmp4 };
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, len - pos);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let hdr = 8;
    if (size === 1) {
      if (pos + 16 > len) return { total: null, durationSec, isFmp4 };
      const dv64 = new DataView(buf.buffer, buf.byteOffset + pos + 8, 8);
      size = dv64.getUint32(0) * 4294967296 + dv64.getUint32(4);
      hdr = 16;
    }
    if (size === 0 || size < hdr) return { total: null, durationSec, isFmp4 };
    if (type === "moov" && pos + size <= len) {
      const end = pos + size;
      let c = pos + 8;
      while (c + 8 <= end) {
        const cv = new DataView(buf.buffer, buf.byteOffset + c, end - c);
        const csize = cv.getUint32(0);
        const ctype = String.fromCharCode(buf[c + 4], buf[c + 5], buf[c + 6], buf[c + 7]);
        if (ctype === "mvhd" && csize >= 32) {
          const version = buf[c + 8];
          let timescale = 0;
          let duration = 0;
          if (version === 1) {
            if (c + 40 <= end) {
              timescale = new DataView(buf.buffer, buf.byteOffset + c + 28, 4).getUint32(0);
              const dvd = new DataView(buf.buffer, buf.byteOffset + c + 32, 8);
              duration = dvd.getUint32(0) * 4294967296 + dvd.getUint32(4);
            }
          } else {
            if (c + 28 <= end) {
              timescale = new DataView(buf.buffer, buf.byteOffset + c + 20, 4).getUint32(0);
              duration = new DataView(buf.buffer, buf.byteOffset + c + 24, 4).getUint32(0);
            }
          }
          if (timescale > 0 && duration > 0) durationSec = duration / timescale;
        } else if (ctype === "mvex") {
          isFmp4 = true;
          const mEnd = c + csize;
          let m = c + 8;
          while (m + 8 <= mEnd) {
            const msz = new DataView(buf.buffer, buf.byteOffset + m, 4).getUint32(0);
            const mtyp = String.fromCharCode(buf[m + 4], buf[m + 5], buf[m + 6], buf[m + 7]);
            if (mtyp === "mehd" && msz >= 20) {
              const mver = buf[m + 8];
              if (mver === 1 && m + 20 <= mEnd) {
                const dv8 = new DataView(buf.buffer, buf.byteOffset + m + 12, 8);
                const frag = dv8.getUint32(0) * 4294967296 + dv8.getUint32(4);
                if (frag > 0 && durationSec === null) durationSec = frag / 1000;
              } else if (m + 16 <= mEnd) {
                const frag = new DataView(buf.buffer, buf.byteOffset + m + 12, 4).getUint32(0);
                if (frag > 0 && durationSec === null) durationSec = frag / 1000;
              }
            }
            if (msz < 8) break;
            m += msz;
          }
        }
        if (csize < 8) break;
        c += csize;
      }
    }
    if (type === "mdat" && !isFmp4) return { total: pos + size, durationSec, isFmp4 };
    pos += size;
    if (pos > len) return { total: null, durationSec, isFmp4 };
  }
}

function concatBufs(bufs: Uint8Array[], total: number): Uint8Array {
  const flat = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    flat.set(b, off);
    off += b.length;
  }
  return flat;
}

/** Source ke pehle ~1MB se MP4 metadata (total / duration / fMP4).
    STALE/stream errors aage phainkta hai (caller retry karega). */
async function probeSource(src: Source): Promise<ProbeMeta> {
  const bufs: Uint8Array[] = [];
  let n = 0;
  let pos = 0;
  while (n < MP4_PROBE_MAX) {
    const chunk = await readFrom(src, pos);
    if (!chunk) break;
    bufs.push(chunk);
    n += chunk.length;
    pos += chunk.length;
    if (n >= 64) {
      const meta = parseMeta(concatBufs(bufs, n), n);
      if (meta.isFmp4) return meta; // total unreliable
      if (meta.total !== null && meta.total > 0) return meta;
    }
  }
  if (src.total !== null) return { total: src.total, durationSec: null, isFmp4: false };
  return { total: null, durationSec: null, isFmp4: false };
}

/* ---------------- Resolve (stale retry + broken transcode refresh) ---------------- */

const isVideoFmt = (fmt: string) => !AUDIO_FORMATS.includes(fmt);

const looksBroken = (meta: ProbeMeta): boolean => {
  const dur = meta.durationSec;
  if (dur !== null && dur > 0 && dur < 4) return true; // ~2s ka tukra
  if (!meta.isFmp4 && dur === 0 && (meta.total ?? 0) < 150_000) return true; // 150KB se chhota "video"
  return false;
};

async function resolveSource(
  url: string,
  fmt: string
): Promise<{ src: Source; meta: ProbeMeta; title: string }> {
  let title = "";
  for (let t = 0; t < 3; t++) {
    const result = await getResult(url, fmt);
    title = result?.title ?? title;
    const du = result?.download_url;
    if (!du) throw new Error("download_url nahi mila");
    const getFresh = async (): Promise<string> => {
      invalidateCache(url, fmt);
      const r = await getResult(url, fmt);
      return r?.download_url ?? "";
    };
    let src = await ensureSource(du, getFresh);
    if (src.err?.message === "STALE") continue;
    if (src.err) throw src.err;
    let meta: ProbeMeta;
    try {
      if (!src.probePromise) src.probePromise = probeSource(src);
      meta = await src.probePromise;
    } catch (e) {
      if (e instanceof Error && e.message === "STALE") continue;
      throw e;
    }
    console.log(
      `[probe] ${meta.isFmp4 ? "fMP4" : "prog"} total=${meta.total ?? "?"} dur=${
        meta.durationSec !== null ? meta.durationSec.toFixed(2) : "?"
      }s ${src.key.slice(-24)}`
    );
    if (isVideoFmt(fmt) && looksBroken(meta) && t < 2) {
      console.log("[probe] BROKEN TRANSCODE -> refresh");
      invalidateCache(url, fmt);
      const r2 = await getResult(url, fmt);
      const du2 = r2?.download_url;
      if (du2 && du2 !== du) {
        const src2 = await ensureSource(du2, getFresh);
        if (src2.err?.message === "STALE") continue;
        let meta2: ProbeMeta | null = null;
        if (!src2.err && src2 !== src) {
          try {
            if (!src2.probePromise) src2.probePromise = probeSource(src2);
            meta2 = await src2.probePromise;
          } catch (e) {
            if (e instanceof Error && e.message === "STALE") continue;
            throw e;
          }
          console.log(
            `[probe] retry ${meta2.isFmp4 ? "fMP4" : "prog"} total=${meta2.total ?? "?"} dur=${
              meta2.durationSec !== null ? meta2.durationSec.toFixed(2) : "?"
            }s`
          );
          if (!looksBroken(meta2)) {
            return { src: src2, meta: meta2, title: r2?.title ?? title };
          }
        }
      }
      // refresh se bhi broken -> jo hai wohi serve karo
    }
    return { src, meta, title };
  }
  throw new Error("source resolve fail");
}

/* ---------------- GET ---------------- */

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const url = resolveVideoUrl(sp, req.nextUrl.search);
    const fmt = normFormat(sp.get("format"));
    const customName = sp.get("filename");
    const inline = sp.get("inline") === "1";

    // Client Range parse: bytes=X-Y (dono optional)
    const rm = (req.headers.get("range") || "").match(/bytes=(\d*)-(\d*)/);
    let start = 0;
    let endIncl: number | null = null;
    const hasRange = !!rm && (rm[1] !== "" || rm[2] !== "");
    if (hasRange && rm) {
      if (rm[1] !== "") start = parseInt(rm[1], 10);
      if (rm[2] !== "") endIncl = parseInt(rm[2], 10);
    }

    const { src, meta, title } = await resolveSource(url, fmt);
    // Response khatam hone ke baad bhi fill zinda rakho (Vercel waitUntil)
    if (src.fillPromise) {
      try {
        after(() => src.fillPromise!);
      } catch {
        /* after() na ho to bhi theek */
      }
    }
    // fMP4 mein mdat-based total jhoota hota hai — magar fill COMPLETE ho gaya
    // (src.total set) to asli total mil chuka hai, phir sahi 206 slices de sakte hain
    const total = meta.isFmp4 ? src.total : (meta.total ?? src.total);

    const ext = EXT[fmt] || "bin";
    const name = customName || safeName(title, ext);

    const headers = new Headers();
    headers.set("Content-Type", ext === "mp4" ? "video/mp4" : "application/octet-stream");
    if (ext === "mp3") headers.set("Content-Type", "audio/mpeg");
    if (ext === "m4a") headers.set("Content-Type", "audio/mp4");
    if (ext === "aac") headers.set("Content-Type", "audio/aac");
    if (ext === "flac") headers.set("Content-Type", "audio/flac");
    if (ext === "opus") headers.set("Content-Type", "audio/ogg");
    if (ext === "ogg") headers.set("Content-Type", "audio/ogg");
    if (ext === "wav") headers.set("Content-Type", "audio/wav");
    headers.set("Content-Disposition", contentDisposition(name, inline));
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");

    console.log(
      `[file] ${req.headers.get("range") ?? "-"} total=${total ?? "?"} fmp4=${meta.isFmp4} seen=${src.bytesSeen} ${src.key.slice(-24)}`
    );

    // fMP4 jab tak fill ho raha hai (total unknown) -> 200 progressive (jhoota
    // Content-Range/CL KABHI nahi). Accept-Ranges bhi tabhi advertise karo.
    if (total === null) {
      headers.set("Accept-Ranges", "none");
      return new Response(streamFrom(src, 0, null), { status: 200, headers });
    }

    headers.set("Accept-Ranges", "bytes");
    if (!hasRange) {
      headers.set("Content-Length", String(total));
      return new Response(streamFrom(src, 0, null), { status: 200, headers });
    }

    if (start >= total) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const effEnd = endIncl !== null ? endIncl : total - 1;
    headers.set("Content-Range", `bytes ${start}-${effEnd}/${total}`);
    headers.set("Content-Length", String(effEnd - start + 1));
    return new Response(streamFrom(src, start, effEnd), { status: 206, headers });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 502 }
    );
  }
}
