/**
 * SavenNow Unofficial Engine
 * ==========================
 * p.savenow.to (Loader.to) ke button-API ka unofficial wrapper (bina API key).
 *
 * Flow:
 *  1. Headless Chromium se button page khulta hai (/api/button/?url=...&f=...)
 *  2. #downloadButton auto-click hota hai -> site ka apna JS /api/v2/download call karta hai
 *  3. Wo JSON response intercept hota hai -> { id, info: { title, image } }
 *  4. Progress plain HTTP fetch se poll hota hai (ye endpoint bot-protected nahi)
 *  5. success=1 + download_url milne par result cache ho jata hai
 */
import path from "path";
import os from "os";
import { chromium, type Browser } from "playwright-core";

const BASE = "https://p.savenow.to";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const RESOLVE_TIMEOUT_MS = 75_000; // browser se id milne tak
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_MS = 20 * 60_000; // 20 min
export const CACHE_TTL_MS = 2 * 60 * 60_000; // 2 ghantay
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 3) || 3;

export const FORMAT_ALIASES: Record<string, string> = {
  mp3: "mp3", m4a: "m4a", aac: "aac", flac: "flac",
  opus: "opus", ogg: "ogg", wav: "wav",
  webm: "webm", webm_audio: "webm",
  "360": "360", "480": "480", "720": "720", "1080": "1080",
  "4k": "4k", "8k": "8k",
  mp4: "720", mp44k: "4k", mp41080: "1080", hd: "720",
};
export const VIDEO_FORMATS = ["360", "480", "720", "1080", "4k", "8k"];
export const AUDIO_FORMATS = ["mp3", "m4a", "aac", "flac", "opus", "ogg", "wav", "webm"];
export const EXT: Record<string, string> = {
  mp3: "mp3", m4a: "m4a", aac: "aac", flac: "flac",
  opus: "opus", ogg: "ogg", wav: "wav", webm: "webm",
  ...Object.fromEntries(VIDEO_FORMATS.map((v) => [v, "mp4"])),
};

export type JobStatus = "processing" | "ready" | "failed";

export interface Job {
  id: string;
  url: string;
  format: string;
  title: string;
  thumbnail: string;
  progress: number; // 0-1000 (savenow scale)
  status: JobStatus;
  final: Record<string, unknown> | null;
  error: string | null;
  resolve: ((p: FinalPayload | null) => void) | null;
  created: number;
}

export interface FinalPayload {
  success: true;
  id: string;
  title: string;
  thumbnail: string;
  format: string;
  download_url: string;
  progress: 100;
}

interface ProgressResp {
  progress?: number;
  success?: number | boolean;
  download_url?: string;
  text?: string;
  message?: string;
  info?: { title?: string };
}

interface Store {
  browser: Browser | null;
  launching: Promise<Browser> | null;
  jobs: Map<string, Job>;
  inflight: Map<string, Promise<FinalPayload>>;
  cache: Map<string, { ts: number; data: FinalPayload }>;
  sem: number;
  queue: (() => void)[];
}

const g = globalThis as unknown as { __savenowStore?: Store };
export const store: Store = (g.__savenowStore ??= {
  browser: null,
  launching: null,
  jobs: new Map(),
  inflight: new Map(),
  cache: new Map(),
  sem: 0,
  queue: [],
});

function log(...a: unknown[]) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

/* --------------------------- Semaphore (MAX_PAGES) --------------------------- */
async function withPageSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (store.sem >= MAX_PAGES) {
    await new Promise<void>((res) => store.queue.push(res));
  }
  store.sem++;
  try {
    return await fn();
  } finally {
    store.sem--;
    const next = store.queue.shift();
    if (next) next();
  }
}

/* --------------------------------- Browser --------------------------------- */
function chromePath(): string {
  return (
    process.env.CHROME_PATH ||
    path.join(os.homedir(), ".cache/ms-playwright/chromium-1200/chrome-linux64/chrome")
  );
}

export async function getBrowser(): Promise<Browser> {
  if (store.browser?.isConnected()) return store.browser;
  if (store.launching) return store.launching;
  store.launching = (async () => {
    log("Browser launch ho raha hai...");
    let executablePath: string;
    let args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ];
    if (process.env.VERCEL) {
      // Vercel serverless: @sparticuz/chromium (lambda-optimized chromium, /tmp mein extract hota hai)
      const ch = (await import("@sparticuz/chromium")).default;
      executablePath = await ch.executablePath();
      args = [...ch.args, "--disable-blink-features=AutomationControlled", "--disable-gpu"];
      log("Vercel chromium:", executablePath);
    } else {
      executablePath = chromePath();
    }
    const browser = await chromium.launch({
      headless: true,
      executablePath,
      args,
    });
    browser.on("disconnected", () => {
      store.browser = null;
      store.launching = null;
    });
    store.browser = browser;
    store.launching = null;
    return browser;
  })();
  return store.launching;
}

/* ------------------------------ Resolve job id ------------------------------ */
export async function resolveJobId(url: string, fmt: string): Promise<{
  id: string;
  title: string;
  thumbnail: string;
}> {
  return withPageSlot(async () => {
    const browser = await getBrowser();
    const btnUrl = `${BASE}/api/button/?url=${encodeURIComponent(url)}&f=${encodeURIComponent(fmt)}`;
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 420, height: 140 },
    });
    await ctx.addInitScript(
      "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
    );
    const page = await ctx.newPage();
    const captured: Record<string, unknown> = {};

    page.on("response", (resp) => {
      if (!resp.url().includes("/api/v2/download")) return;
      resp
        .json()
        .then((data: Record<string, unknown>) => {
          if (data && data.id) {
            Object.assign(captured, data);
            log("v2/download captured:", String(data.id));
          }
        })
        .catch(() => {});
    });

    try {
      await page.goto(btnUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1500);
      try {
        await page.click("#downloadButton", { timeout: 5000 });
      } catch {
        await page.evaluate("typeof d === 'function' && d()");
      }
      const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
      while (!captured["id"] && Date.now() < deadline) {
        await page.waitForTimeout(500);
      }
    } finally {
      await ctx.close().catch(() => {});
    }

    if (!captured["id"]) {
      throw new Error("Job id nahi mila (site ne response nahi diya)");
    }
    const info = (captured["info"] ?? {}) as { title?: string; image?: string };
    return {
      id: String(captured["id"]),
      title: info.title || "video",
      thumbnail: info.image || "",
    };
  });
}

/* ------------------------------ Progress polling ----------------------------- */
export async function pollOnce(jobId: string): Promise<ProgressResp> {
  const res = await fetch(`${BASE}/api/progress?id=${encodeURIComponent(jobId)}`, {
    headers: { "User-Agent": UA, Referer: `${BASE}/` },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`progress HTTP ${res.status}`);
  return (await res.json()) as ProgressResp;
}

async function pollJob(job: Job): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < POLL_MAX_MS) {
    let data: ProgressResp;
    try {
      data = await pollOnce(job.id);
    } catch (e) {
      log("poll error", job.id, String(e));
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const prog = data.progress ?? 0;
    job.progress = prog;
    if (prog >= 1000) {
      if (data.success && data.download_url) {
        job.final = data as Record<string, unknown>;
        job.status = "ready";
        const key = `${job.url}|${job.format}`;
        store.cache.set(key, { ts: Date.now(), data: finalPayload(job) });
        log("READY", job.id, "->", data.download_url.slice(0, 60));
      } else {
        job.status = "failed";
        job.error = data.text || data.message || "Download fail hua";
        log("FAILED", job.id, job.error);
      }
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (job.status === "processing") {
    job.status = "failed";
    job.error = "Timeout (20 min) - video bohat lambi thi";
  }
  job.resolve?.(job.status === "ready" ? finalPayload(job) : null);
  job.resolve = null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function finalPayload(job: Job): FinalPayload {
  const f = (job.final ?? {}) as { download_url?: string };
  return {
    success: true,
    id: job.id,
    title: job.title,
    thumbnail: job.thumbnail,
    format: job.format,
    download_url: f.download_url ?? "",
    progress: 100,
  };
}

/* --------------------------------- Job flow --------------------------------- */
export async function startNewJob(url: string, fmt: string): Promise<Job> {
  const meta = await resolveJobId(url, fmt);
  let resolveFn: ((p: FinalPayload | null) => void) | null = null;
  const readyPromise = new Promise<FinalPayload | null>((res) => {
    resolveFn = res;
  });
  const job: Job = {
    id: meta.id,
    url,
    format: fmt,
    title: meta.title,
    thumbnail: meta.thumbnail,
    progress: 0,
    status: "processing",
    final: null,
    error: null,
    resolve: resolveFn,
    created: Date.now(),
  };
  // readyPromise ko job par attach karo (internal use)
  (job as Job & { ready: Promise<FinalPayload | null> }).ready = readyPromise;
  store.jobs.set(meta.id, job);
  void pollJob(job);
  log("JOB START", meta.id, `[${fmt}]`, meta.title);
  return job;
}

export async function waitReady(job: Job): Promise<FinalPayload> {
  const ready = (job as Job & { ready?: Promise<FinalPayload | null> }).ready;
  if (job.status === "ready" && job.final) return finalPayload(job);
  if (job.status === "failed") throw new Error(job.error || "Download fail hua");
  const result = await Promise.race([
    ready ?? Promise.resolve(null),
    sleep(POLL_MAX_MS + 15_000).then(() => null),
  ]);
  if (!result) throw new Error(job.error || "Download fail hua / timeout");
  return result;
}

export function normFormat(fmt: string | null): string {
  const f = (fmt || "720").trim().toLowerCase();
  if (!FORMAT_ALIASES[f]) {
    throw new Error(`Format '${fmt}' supported nahi. /api/formats dekho`);
  }
  return FORMAT_ALIASES[f];
}

export function checkUrl(url: string | null): string {
  const u = (url || "").trim();
  if (!/^https?:\/\//i.test(u)) {
    throw new Error("Valid video URL do (https://...)");
  }
  return u;
}

export async function getResult(url: string, fmt: string): Promise<FinalPayload> {
  const key = `${url}|${fmt}`;
  const c = store.cache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return { ...c.data };

  const existing = store.inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const job = await startNewJob(url, fmt);
    return await waitReady(job);
  })().finally(() => {
    store.inflight.delete(key);
    pruneOldJobs();
  });
  store.inflight.set(key, p);
  return p;
}

export function invalidateCache(url: string, fmt: string) {
  store.cache.delete(`${url}|${fmt}`);
}

export function pruneOldJobs() {
  const now = Date.now();
  for (const [id, job] of store.jobs) {
    if (now - job.created > CACHE_TTL_MS && job.status !== "processing") {
      store.jobs.delete(id);
    }
  }
}

export function safeName(title: string, ext: string): string {
  const t = title.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 80) || "video";
  return `${t}.${ext}`;
}
