"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Download, Loader2, PlayCircle, AlertCircle, Braces } from "lucide-react";

interface StartResp {
  success: boolean;
  status?: string;
  progress?: number;
  id?: string;
  title?: string;
  thumbnail?: string;
  error?: string;
}
interface StatusResp {
  success: boolean;
  status?: string;
  progress?: number;
  title?: string;
  thumbnail?: string;
  download_url?: string;
  error?: string;
}

const FORMAT_OPTIONS: { group: string; items: { value: string; label: string }[] }[] = [
  {
    group: "Video (MP4)",
    items: [
      { value: "360", label: "MP4 360p" },
      { value: "480", label: "MP4 480p" },
      { value: "720", label: "MP4 720p" },
      { value: "1080", label: "MP4 1080p" },
      { value: "4k", label: "MP4 4K" },
      { value: "8k", label: "MP4 8K" },
    ],
  },
  {
    group: "Audio",
    items: [
      { value: "mp3", label: "MP3" },
      { value: "m4a", label: "M4A" },
      { value: "aac", label: "AAC" },
      { value: "flac", label: "FLAC" },
      { value: "opus", label: "OPUS" },
      { value: "ogg", label: "OGG" },
      { value: "wav", label: "WAV" },
    ],
  },
];

const AUDIO_SET = new Set([
  "mp3", "m4a", "aac", "flac", "opus", "ogg", "wav", "webm",
]);

export default function Home() {
  const [url, setUrl] = useState("");
  const [fmt, setFmt] = useState("720");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<StatusResp | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [lastJson, setLastJson] = useState<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const poll = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`/api/status/${encodeURIComponent(id)}`, { cache: "no-store" });
        const d: StatusResp = await r.json();
        setLastJson(JSON.stringify(d, null, 2));
        if (typeof d.progress === "number") {
          setProgress(Math.max(5, d.progress));
        }
        if (d.status === "ready") {
          stopTimer();
          setProgress(100);
          setStatusText(`Ready! (${d.title || "video"})`);
          setResult(d);
          setBusy(false);
        } else if (d.status === "failed") {
          stopTimer();
          setError(d.error || "Download fail hua");
          setBusy(false);
        }
      } catch {
        /* network hiccup — agli baar try hoga */
      }
    },
    [stopTimer]
  );

  const start = useCallback(async () => {
    const u = url.trim();
    if (!u) {
      setError("Pehle video URL paste karo");
      return;
    }
    setError("");
    setResult(null);
    setShowJson(false);
    setBusy(true);
    setProgress(5);
    setStatusText("Job shuru ho raha hai...");
    try {
      const r = await fetch(
        `/api/start?url=${encodeURIComponent(u)}&format=${encodeURIComponent(fmt)}`,
        { cache: "no-store" }
      );
      const d: StartResp = await r.json();
      setLastJson(JSON.stringify(d, null, 2));
      if (!d.success || !d.id) {
        throw new Error(d.error || "Start fail hua");
      }
      jobIdRef.current = d.id;
      if (d.status === "ready") {
        setStatusText(`Ready! (${d.title || "video"})`);
        setResult({ ...d, download_url: undefined });
        setBusy(false);
        setProgress(100);
        return;
      }
      setStatusText("Processing... 5%");
      stopTimer();
      timerRef.current = setInterval(() => {
        if (jobIdRef.current) void poll(jobIdRef.current);
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kuch ghalat ho gaya");
      setBusy(false);
    }
  }, [url, fmt, poll, stopTimer]);

  const done = result?.status === "ready" || result?.progress === 100;
  const fileHref = `/api/file?url=${encodeURIComponent(url.trim())}&format=${encodeURIComponent(fmt)}`;
  const isVideo = !AUDIO_SET.has(fmt);
  const isAudio = AUDIO_SET.has(fmt);

  return (
    <div className="min-h-screen flex flex-col bg-[#0f1220] text-slate-100">
      <main className="flex-1 w-full max-w-xl mx-auto px-4 py-8">
        {/* Header */}
        <header className="mb-6">
          <h1 className="text-3xl font-extrabold tracking-tight">
            Saven<span className="text-emerald-400">Now</span> Downloader
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Unofficial API — video URL paste karo, seedha download link pao
          </p>
        </header>

        {/* Input card */}
        <Card className="bg-[#181c30] border-[#262c4a] mb-4">
          <CardContent className="p-5 space-y-4">
            <div className="space-y-2">
              <label htmlFor="vurl" className="text-xs text-slate-400 font-medium">
                Video URL (YouTube etc.)
              </label>
              <Input
                id="vurl"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="bg-[#10131f] border-[#2c3358] text-slate-100 placeholder:text-slate-600 focus-visible:ring-emerald-400 h-11"
                onKeyDown={(e) => e.key === "Enter" && !busy && start()}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-slate-400 font-medium">Format</label>
              <Select value={fmt} onValueChange={setFmt} disabled={busy}>
                <SelectTrigger className="bg-[#10131f] border-[#2c3358] text-slate-100 h-11 w-full">
                  <SelectValue placeholder="Format chuno" />
                </SelectTrigger>
                <SelectContent className="bg-[#181c30] border-[#2c3358] text-slate-100">
                  {FORMAT_OPTIONS.map((g) => (
                    <SelectGroup key={g.group}>
                      <SelectLabel className="text-slate-500 text-xs">{g.group}</SelectLabel>
                      {g.items.map((it) => (
                        <SelectItem key={it.value} value={it.value}>
                          {it.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={start}
              disabled={busy}
              className="w-full h-12 bg-emerald-400 text-[#08130d] hover:bg-emerald-300 font-bold text-base"
            >
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Chal raha hai...
                </>
              ) : (
                <>
                  <PlayCircle className="mr-2 h-5 w-5" /> Download Shuru Karo
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Progress card */}
        {busy && (
          <Card className="bg-[#181c30] border-[#262c4a] mb-4">
            <CardContent className="p-5">
              <p className="text-sm text-slate-400 mb-2">{statusText}</p>
              <Progress
                value={progress}
                className="h-2 bg-[#10131f] [&>div]:bg-gradient-to-r [&>div]:from-emerald-400 [&>div]:to-teal-400"
              />
              <button
                onClick={() => setShowJson((v) => !v)}
                className="mt-3 text-xs text-teal-300 hover:underline inline-flex items-center gap-1"
              >
                <Braces className="h-3 w-3" /> JSON dekho
              </button>
              {showJson && (
                <pre className="mt-2 bg-[#10131f] text-emerald-300 text-[11px] rounded-lg p-3 overflow-auto max-h-48">
                  {lastJson}
                </pre>
              )}
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {error && (
          <Alert className="mb-4 bg-[#3a1d24] border-[#5c2b36] text-rose-300">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Error: {error}</AlertDescription>
          </Alert>
        )}

        {/* Result card */}
        {result && done && (
          <Card className="bg-[#181c30] border-[#262c4a] mb-4">
            <CardContent className="p-5">
              {isVideo ? (
                <video
                  key={fileHref}
                  src={`${fileHref}&inline=1`}
                  controls
                  preload="metadata"
                  playsInline
                  poster={result.thumbnail}
                  className="w-full rounded-xl mb-3 bg-black aspect-video"
                />
              ) : (
                result.thumbnail && (
                  <img
                    src={result.thumbnail}
                    alt="Video thumbnail"
                    className="w-full rounded-xl mb-3"
                  />
                )
              )}
              <h3 className="font-bold text-base mb-1 leading-snug">{result.title}</h3>
              <Badge className="mb-3 bg-emerald-400/15 text-emerald-300 border-0">
                {FORMAT_OPTIONS.flatMap((g) => g.items).find((i) => i.value === fmt)?.label || fmt}
              </Badge>
              {isAudio && (
                <audio
                  key={fileHref}
                  src={`${fileHref}&inline=1`}
                  controls
                  preload="metadata"
                  className="w-full mb-3"
                />
              )}
              <div className="space-y-2">
                <a href={fileHref} download>
                  <Button className="w-full h-12 bg-emerald-400 text-[#08130d] hover:bg-emerald-300 font-bold">
                    <Download className="mr-2 h-5 w-5" /> Download Karo
                  </Button>
                </a>
                <a href={`${fileHref}&inline=1`} target="_blank" rel="noreferrer">
                  <Button
                    variant="secondary"
                    className="w-full h-11 bg-[#262c4a] text-teal-200 hover:bg-[#2e3559] font-medium"
                  >
                    <PlayCircle className="mr-2 h-4 w-4" /> Naye Tab Mein Chalao
                  </Button>
                </a>
                {result.download_url && (
                  <p className="text-[11px] text-slate-500 break-all pt-1">
                    Direct savenow link (kuch networks par block ho sakta hai):{" "}
                    <a href={result.download_url} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-teal-300 underline">
                      {result.download_url.slice(0, 60)}…
                    </a>
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      <footer className="mt-auto text-center text-[11px] text-slate-600 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <p>
          API endpoints: <code>/api/link?url=...&amp;format=mp3</code> ·{" "}
          <code>/api/file?url=...&amp;format=720</code> · <code>/api/start</code> ·{" "}
          <code>/api/status/&#123;id&#125;</code>
        </p>
        <p className="mt-1">
          Sirf personal use ke liye — savenow.to (Loader.to) ke unofficial flow par bana hai.
        </p>
      </footer>
    </div>
  );
}
