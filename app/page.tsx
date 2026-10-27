"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ConversionMode,
  ConvertEvent,
  DetectedType,
  FileStatus,
  FileUpdate,
} from "@/lib/types";

type FileRow = FileUpdate & { status: FileStatus };

interface LogLine {
  time: string;
  text: string;
  tone: "info" | "success" | "warn" | "error";
}

const MODE_OPTIONS: { value: ConversionMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto-Detect", hint: "Video → 720p MP4, audio-only → MP3" },
  { value: "mp3", label: "Force MP3 Only", hint: "Extract audio from everything" },
  { value: "mp4", label: "Force MP4", hint: "720p H.264/AAC, audio-only MP4 if no video" },
];

const DETECTED_LABEL: Record<DetectedType, string> = {
  video: "Video",
  "audio-only": "Audio-only",
  unknown: "Unknown",
};

const STATUS_STYLE: Record<FileStatus, string> = {
  queued: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  probing: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  processing: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  skipped: "bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-emerald-600/30 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-emerald-400/30",
  error: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

const STATUS_LABEL: Record<FileStatus, string> = {
  queued: "Queued",
  probing: "Detecting…",
  processing: "Processing",
  completed: "Completed",
  skipped: "Skipped",
  error: "Error",
};

const LOG_TONE: Record<LogLine["tone"], string> = {
  info: "text-zinc-600 dark:text-zinc-400",
  success: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-red-700 dark:text-red-400",
};

const SETTINGS_KEY = "mxf-converter-settings";

interface Settings {
  source: string;
  destination: string;
  mode: ConversionMode;
  skipExisting: boolean;
}

const DEFAULT_SETTINGS: Settings = { source: "", destination: "", mode: "auto", skipExisting: true };

function readSavedSettings(): string | null {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}

function parseSettings(raw: string | null): Settings {
  try {
    const saved = JSON.parse(raw ?? "{}");
    return {
      source: typeof saved.source === "string" ? saved.source : "",
      destination: typeof saved.destination === "string" ? saved.destination : "",
      mode: ["auto", "mp3", "mp4"].includes(saved.mode) ? saved.mode : "auto",
      skipExisting: typeof saved.skipExisting === "boolean" ? saved.skipExisting : true,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Final states: the file needs no more work in this batch. */
function isDone(status: FileStatus) {
  return status === "completed" || status === "skipped" || status === "error";
}

function now() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

// Folders and options are remembered across restarts (e.g. after a power cut).
// The server render has no localStorage, so the form remounts with the saved
// values once the browser snapshot is available.
export default function Home() {
  const raw = useSyncExternalStore(
    () => () => {},
    readSavedSettings,
    () => null,
  );
  const initial = useMemo(() => parseSettings(raw), [raw]);
  return <Converter key={raw ?? ""} initial={initial} />;
}

function Converter({ initial }: { initial: Settings }) {
  const [source, setSource] = useState(initial.source);
  const [destination, setDestination] = useState(initial.destination);
  const [mode, setMode] = useState<ConversionMode>(initial.mode);
  const [skipExisting, setSkipExisting] = useState(initial.skipExisting);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ completed: number; skipped: number; failed: number } | null>(null);
  const [picking, setPicking] = useState<"source" | "destination" | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastStatus = useRef(new Map<number, FileStatus>());
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "nearest" });
  }, [log]);

  const addLog = (text: string, tone: LogLine["tone"] = "info") =>
    setLog((prev) => [...prev, { time: now(), text, tone }]);

  /** Opens the OS folder dialog (via the local server) and fills in the chosen path. */
  async function pickFolder(target: "source" | "destination") {
    setPicking(target);
    setError(null);
    try {
      const res = await fetch("/api/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: target === "source" ? "Select the folder with .mxf files" : "Select the destination folder",
          current: target === "source" ? source : destination || source,
        }),
      });
      const data: { path?: string; cancelled?: boolean; error?: string } = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.path) (target === "source" ? setSource : setDestination)(data.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(null);
    }
  }

  function handleEvent(event: ConvertEvent) {
    switch (event.type) {
      case "start":
        setRows(event.files.map((name, index) => ({ index, name, status: "queued" })));
        addLog(`Found ${event.total} file${event.total === 1 ? "" : "s"} to convert.`);
        break;

      case "file": {
        const update: FileUpdate = event;
        setRows((prev) =>
          prev.map((row) => (row.index === update.index ? { ...row, ...update } as FileRow : row)),
        );
        // Log only status transitions, not every percent tick.
        if (update.status && update.status !== lastStatus.current.get(update.index)) {
          lastStatus.current.set(update.index, update.status);
          logTransition(update);
        }
        break;
      }

      case "done":
        setSummary({ completed: event.completed, skipped: event.skipped, failed: event.failed });
        addLog(
          `Batch finished: ${event.completed} converted, ${event.skipped} skipped (already done), ${event.failed} failed.`,
          event.failed ? "warn" : "success",
        );
        break;

      case "fatal":
        setError(event.message);
        addLog(`Fatal: ${event.message}`, "error");
        break;
    }
  }

  function logTransition(u: FileUpdate) {
    switch (u.status) {
      case "probing":
        addLog(`${u.name}: probing streams with ffprobe…`);
        break;
      case "processing":
        addLog(
          `${u.name}: detected ${DETECTED_LABEL[u.detected ?? "unknown"]} → ${u.format?.toUpperCase()} (${u.pipeline})`,
        );
        if (u.message) addLog(`${u.name}: ${u.message}`, "warn");
        break;
      case "completed":
        addLog(`${u.name}: completed${u.pipeline ? ` via ${u.pipeline}` : ""}`, "success");
        break;
      case "skipped":
        addLog(`${u.name}: already converted → skipped`);
        break;
      case "error":
        addLog(`${u.name}: ${u.message ?? "failed"}`, "error");
        break;
    }
  }

  async function start() {
    const controller = new AbortController();
    abortRef.current = controller;
    lastStatus.current.clear();
    setRunning(true);
    setError(null);
    setSummary(null);
    setRows([]);
    setLog([{ time: now(), text: `Scanning ${source} …`, tone: "info" }]);
    try {
      const settings: Settings = { source, destination, mode, skipExisting };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}

    try {
      const res = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, destination, mode, skipExisting }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Server responded ${res.status}`);
      }

      // The API streams newline-delimited JSON events.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) handleEvent(JSON.parse(line) as ConvertEvent);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        addLog("Cancelled by user. The current FFmpeg process was stopped.", "warn");
        setRows((prev) =>
          prev.map((row) =>
            row.status === "probing" || row.status === "processing"
              ? { ...row, status: "error", message: "Cancelled" }
              : row,
          ),
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        addLog(message, "error");
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const finished = rows.filter((r) => isDone(r.status)).length;
  const overall = rows.length
    ? Math.round(
        rows.reduce(
          (sum, r) =>
            sum +
            (isDone(r.status)
              ? 100
              : r.status === "processing"
                ? (r.percent ?? 0)
                : 0),
          0,
        ) / rows.length,
      )
    : 0;

  const inputClass =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none transition focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-300 dark:focus:ring-zinc-100/10";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">MXF Batch Converter</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Probes each <code className="font-mono">.mxf</code> file with FFprobe, then converts video to
          720p MP4 (H.264/AAC) and audio-only files to MP3.
        </p>
      </header>

      <form
        className="space-y-5 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) start();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              { target: "source", label: "Source Folder Path", value: source, set: setSource },
              { target: "destination", label: "Destination Folder Path", value: destination, set: setDestination },
            ] as const
          ).map((field) => (
            <div key={field.target}>
              <label htmlFor={field.target} className="mb-1.5 block text-sm font-medium">
                {field.label}
              </label>
              <div className="flex gap-2">
                <input
                  id={field.target}
                  className={`${inputClass} min-w-0 flex-1`}
                  value={field.value}
                  onChange={(e) => field.set(e.target.value)}
                  placeholder="Click Browse… or paste a path"
                  required
                  disabled={running}
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => pickFolder(field.target)}
                  disabled={running || picking !== null}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 px-3 text-sm font-medium transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                    <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4.09a1.5 1.5 0 0 1 1.06.44L9.71 5.5h6.79A1.5 1.5 0 0 1 18 7v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5v-9Z" />
                  </svg>
                  {picking === field.target ? "Opening…" : "Browse…"}
                </button>
              </div>
            </div>
          ))}
        </div>

        <fieldset disabled={running}>
          <legend className="mb-1.5 text-sm font-medium">Conversion Mode</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-lg border px-3 py-2.5 transition has-disabled:cursor-not-allowed ${
                  mode === opt.value
                    ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900 dark:border-zinc-200 dark:bg-zinc-900 dark:ring-zinc-200"
                    : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={opt.value}
                  checked={mode === opt.value}
                  onChange={() => setMode(opt.value)}
                  className="sr-only"
                />
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">{opt.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-60">
          <input
            type="checkbox"
            checked={skipExisting}
            onChange={(e) => setSkipExisting(e.target.checked)}
            disabled={running}
            className="mt-0.5 h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
          />
          <span>
            <span className="font-medium">Skip files already converted (resume)</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
              After a power cut or shutdown, just start again: finished files are skipped and the
              interrupted one is converted from the start. Off: every file is converted again as
              “name (1).mp4”.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={running}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {running ? "Converting…" : "Start Batch Conversion"}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </form>

      {rows.length > 0 && (
        <section className="mt-8">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <h2 className="font-medium">
              Files <span className="text-zinc-500">({finished}/{rows.length})</span>
            </h2>
            <span className="tabular-nums text-zinc-500">
              {summary
                ? `${summary.completed} converted · ${summary.skipped} skipped · ${summary.failed} failed`
                : `${overall}%`}
            </span>
          </div>
          <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-zinc-900 transition-all dark:bg-zinc-100"
              style={{ width: `${overall}%` }}
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">File</th>
                  <th className="px-4 py-2.5 font-medium">Detected</th>
                  <th className="px-4 py-2.5 font-medium">Output</th>
                  <th className="w-40 px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {rows.map((row) => (
                  <tr key={row.index} className="align-top">
                    <td className="px-4 py-3">
                      <div className="break-all font-mono text-xs">
                        {/* Subfolder (if any) dimmed, file name emphasised */}
                        <span className="text-zinc-500">{row.name.slice(0, row.name.search(/[^\\/]*$/))}</span>
                        {row.name.slice(row.name.search(/[^\\/]*$/))}
                      </div>
                      {row.output && (row.status === "completed" || row.status === "skipped") && (
                        <div className="mt-1 break-all font-mono text-xs text-zinc-500">→ {row.output}</div>
                      )}
                      {row.message && (
                        <div
                          className={`mt-1 text-xs ${
                            row.status === "error"
                              ? "text-red-600 dark:text-red-400"
                              : "text-amber-700 dark:text-amber-400"
                          }`}
                        >
                          {row.message}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {row.detected ? DETECTED_LABEL[row.detected] : <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {row.format ? (
                        <>
                          <div className="font-medium uppercase">{row.format}</div>
                          <div className="text-xs text-zinc-500">{row.pipeline}</div>
                        </>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}
                      >
                        {STATUS_LABEL[row.status]}
                        {row.status === "processing" && row.percent !== undefined && ` ${row.percent}%`}
                      </span>
                      {row.status === "processing" && (
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                          <div
                            className={`h-full bg-amber-500 ${row.percent === undefined ? "w-1/3 animate-pulse" : "transition-all"}`}
                            style={row.percent !== undefined ? { width: `${row.percent}%` } : undefined}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {log.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium">Progress Log</h2>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-relaxed dark:border-zinc-800 dark:bg-zinc-900">
            {log.map((line, i) => (
              <div key={i} className={LOG_TONE[line.tone]}>
                <span className="text-zinc-400 dark:text-zinc-600">[{line.time}]</span> {line.text}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        </section>
      )}
    </main>
  );
}
