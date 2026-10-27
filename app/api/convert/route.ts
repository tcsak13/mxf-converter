import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ConversionMode,
  ConvertEvent,
  ConvertRequest,
  DetectedType,
  FileUpdate,
} from "@/lib/types";
import { isMissingBinary, lastLines, run, type RunResult } from "@/lib/run";

// Override any binary location with an env var (handy on Windows, e.g.
// FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe). Otherwise they are looked up on PATH.
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const INPUT_EXTENSION = ".mxf";
// MP4 output is scaled down to this height (1080p → 720p); smaller video is left as is.
const MAX_VIDEO_HEIGHT = 720;
const MODES: ConversionMode[] = ["auto", "mp3", "mp4"];

// ---------------------------------------------------------------------------
// Detection (ffprobe)
// ---------------------------------------------------------------------------

interface ProbeInfo {
  ok: boolean;
  hasVideo: boolean;
  interlaced: boolean;
  audioChannels: number[]; // one entry per audio stream
  duration: number | null; // seconds
  error?: string;
}

interface FfprobeStream {
  codec_type?: string;
  channels?: number;
  field_order?: string;
  disposition?: { attached_pic?: number };
}

async function probe(input: string, signal: AbortSignal): Promise<ProbeInfo> {
  const res = await run(
    FFPROBE,
    [
      "-v", "error",
      "-print_format", "json",
      "-show_entries",
      "format=duration:stream=codec_type,channels,field_order:stream_disposition=attached_pic",
      input,
    ],
    { signal },
  );
  const empty: ProbeInfo = {
    ok: false,
    hasVideo: false,
    interlaced: false,
    audioChannels: [],
    duration: null,
  };
  if (res.code !== 0) return { ...empty, error: lastLines(res.stderr) };

  let parsed: { streams?: FfprobeStream[]; format?: { duration?: string } };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ...empty, error: "ffprobe returned unreadable output" };
  }

  const streams = parsed.streams ?? [];
  // Cover art in audio files shows up as a "video" stream; it isn't real video.
  const video = streams.filter(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const duration = Number(parsed.format?.duration);

  return {
    ok: true,
    hasVideo: video.length > 0,
    interlaced: ["tt", "bb", "tb", "bt"].includes(video[0]?.field_order ?? ""),
    audioChannels: streams
      .filter((s) => s.codec_type === "audio")
      .map((s) => s.channels ?? 0),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

// ---------------------------------------------------------------------------
// Planning: what to do with each file
// ---------------------------------------------------------------------------

type Plan =
  | {
      kind: "ffmpeg";
      detected: DetectedType;
      format: "mp4" | "mp3";
      withVideo: boolean;
      pipeline: string;
      note?: string;
    }
  | { kind: "error"; detected: DetectedType; message: string };

function planFor(mode: ConversionMode, info: ProbeInfo): Plan {
  const hasAudio = info.audioChannels.length > 0;
  const detected: DetectedType = info.hasVideo ? "video" : hasAudio ? "audio-only" : "unknown";

  // Unreadable/corrupt MXF, or one holding only data/timecode tracks.
  if (!info.ok || (!info.hasVideo && !hasAudio)) {
    return {
      kind: "error",
      detected,
      message: info.error ?? "No audio or video streams found",
    };
  }

  const mp4Video = {
    kind: "ffmpeg" as const,
    detected,
    format: "mp4" as const,
    withVideo: true,
    pipeline: `ffmpeg libx264 ≤${MAX_VIDEO_HEIGHT}p CRF 23 + AAC 320k`,
  };
  const mp3 = {
    kind: "ffmpeg" as const,
    detected,
    format: "mp3" as const,
    withVideo: false,
    pipeline: "ffmpeg libmp3lame 320k",
  };

  switch (mode) {
    case "auto":
      // Case A / Case B
      return info.hasVideo ? mp4Video : mp3;
    case "mp3":
      return hasAudio
        ? mp3
        : { kind: "error", detected, message: "Video has no audio stream to extract" };
    case "mp4":
      return info.hasVideo
        ? mp4Video
        : {
            kind: "ffmpeg",
            detected,
            format: "mp4",
            withVideo: false,
            pipeline: "ffmpeg AAC 320k (audio-only MP4)",
            note: "No video stream: writing an audio-only MP4.",
          };
  }
}

// ---------------------------------------------------------------------------
// FFmpeg conversion
// ---------------------------------------------------------------------------

/**
 * Broadcast MXF often stores audio as several mono tracks (one per channel).
 * FFmpeg would otherwise pick just the first one, giving mono output, so merge
 * the first two into stereo when that's the layout.
 */
function audioMapArgs(info: ProbeInfo): string[] {
  const [a, b] = info.audioChannels;
  if (a === 1 && b === 1) {
    return ["-filter_complex", "[0:a:0][0:a:1]amerge=inputs=2,aformat=channel_layouts=stereo[aout]", "-map", "[aout]"];
  }
  return ["-map", "0:a:0"];
}

/**
 * Video filter chain: deinterlace if needed, then shrink to MAX_VIDEO_HEIGHT
 * (never upscale). Width follows the display aspect ratio with square pixels,
 * so anamorphic MXF (e.g. 1440x1080 HDV) comes out as a normal 1280x720.
 */
function videoFilter(info: ProbeInfo): string {
  const h = `min(${MAX_VIDEO_HEIGHT}\\,ih)`;
  const scale = `scale=w=trunc(${h}*dar/2)*2:h=${h}:flags=lanczos,setsar=1`;
  return info.interlaced ? `yadif,${scale}` : scale;
}

function buildFfmpegArgs(
  plan: Extract<Plan, { kind: "ffmpeg" }>,
  info: ProbeInfo,
  input: string,
  output: string,
): string[] {
  const hasAudio = info.audioChannels.length > 0;
  const args = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-i", input];

  if (plan.format === "mp4" && plan.withVideo) {
    // Case A: ffmpeg -i input -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 320k output.mp4
    // plus the 720p cap / deinterlace filter, yuv420p (10-bit / 4:2:2 MXF won't
    // play in browsers otherwise), and faststart for web playback.
    args.push("-map", "0:v:0");
    if (hasAudio) args.push(...audioMapArgs(info));
    args.push(
      "-vf", videoFilter(info),
      "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "320k"] : []),
      "-movflags", "+faststart",
    );
  } else if (plan.format === "mp4") {
    args.push("-vn", ...audioMapArgs(info), "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart");
  } else {
    // Case B: ffmpeg -i input -vn -c:a libmp3lame -b:a 320k output.mp3
    args.push("-vn", ...audioMapArgs(info), "-c:a", "libmp3lame", "-b:a", "320k");
  }

  // Explicit muxer: the output path ends in ".part", so FFmpeg can't infer it.
  args.push("-f", plan.format, output);
  return args;
}

/** Runs ffmpeg, reporting whole-number percent changes from `-progress pipe:1`. */
function runFfmpeg(
  args: string[],
  duration: number | null,
  onPercent: (percent: number) => void,
  signal: AbortSignal,
): Promise<RunResult> {
  let lastPercent = -1;
  let pending = "";
  return run(FFMPEG, args, {
    signal,
    onStdout: (chunk) => {
      if (!duration) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        // Both keys are in microseconds (out_time_ms is misnamed by ffmpeg).
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (!m) continue;
        const percent = Math.min(99, Math.floor((Number(m[1]) / 1e6 / duration) * 100));
        if (percent > lastPercent) {
          lastPercent = percent;
          onPercent(percent);
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Batch driver
// ---------------------------------------------------------------------------

interface BatchOptions {
  source: string;
  destination: string;
  mode: ConversionMode;
  skipExisting: boolean;
}

/** `name.ext`, or `name (1).ext`, `name (2).ext`, … so nothing is ever overwritten. */
async function uniqueOutputPath(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? `${base}.${ext}` : `${base} (${n}).${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * True if `output` is a readable media file roughly as long as the source.
 * Catches truncated files left by a crash or power cut (an MP4 without its
 * index can't be probed at all; a cut-off MP3 is just too short).
 */
async function isCompleteOutput(
  output: string,
  sourceDuration: number | null,
  signal: AbortSignal,
): Promise<boolean> {
  const res = await run(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output],
    { signal },
  );
  const duration = Number(res.stdout.trim());
  if (res.code !== 0 || !Number.isFinite(duration) || duration <= 0) return false;
  if (!sourceDuration) return true;
  return duration >= sourceDuration - Math.max(1, sourceDuration * 0.02);
}

/**
 * Returns "skipped" when the output already exists and is complete, so a
 * batch interrupted by a power cut or shutdown can simply be started again.
 */
async function convertOne(
  index: number,
  name: string,
  opts: BatchOptions,
  emit: (e: ConvertEvent) => void,
  signal: AbortSignal,
): Promise<"completed" | "skipped"> {
  const update = (u: Partial<FileUpdate>) => emit({ type: "file", index, name, ...u });
  // `name` is relative to the source folder (e.g. "Day 1/Cam A/C0001.MXF"); the
  // output goes to the same subfolder under the destination.
  const input = path.join(opts.source, name);
  const base = path.basename(name, path.extname(name));
  // User-chosen folders at runtime; nothing for the build to trace.
  const outDir = path.join(/*turbopackIgnore: true*/ opts.destination, path.dirname(name));

  update({ status: "probing" });
  const info = await probe(input, signal);
  const plan = planFor(opts.mode, info);

  if (plan.kind === "error") {
    update({ detected: plan.detected }); // convertAll reports the error itself
    throw new Error(plan.message);
  }

  let output: string;
  let message = plan.note;
  if (opts.skipExisting) {
    output = path.join(/*turbopackIgnore: true*/ outDir, `${base}.${plan.format}`);
    const exists = await fs.access(output).then(() => true, () => false);
    if (exists) {
      if (await isCompleteOutput(output, info.duration, signal)) {
        update({
          status: "skipped",
          detected: plan.detected,
          format: plan.format,
          pipeline: plan.pipeline,
          output,
          message: "Already converted",
        });
        return "skipped";
      }
      message = "Previous output was incomplete; converting again.";
    }
  } else {
    output = await uniqueOutputPath(outDir, base, plan.format);
  }
  await fs.mkdir(outDir, { recursive: true });

  update({
    status: "processing",
    detected: plan.detected,
    format: plan.format,
    pipeline: plan.pipeline,
    output,
    percent: info.duration ? 0 : undefined,
    message,
  });

  // Encode to "<output>.part" and rename only once FFmpeg succeeds, so an
  // interrupted run never leaves a file that looks finished. A stale .part
  // from an earlier crash is simply overwritten.
  const partial = `${output}.part`;
  let res: RunResult;
  try {
    res = await runFfmpeg(
      buildFfmpegArgs(plan, info, input, partial),
      info.duration,
      (percent) => update({ percent }),
      signal,
    );
  } catch (err) {
    await fs.rm(partial, { force: true });
    throw err;
  }
  if (res.code !== 0) {
    await fs.rm(partial, { force: true });
    throw new Error(lastLines(res.stderr));
  }
  await fs.rename(partial, output);

  update({ status: "completed", percent: 100 });
  return "completed";
}

async function convertAll(
  files: string[],
  opts: BatchOptions,
  emit: (e: ConvertEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  emit({ type: "start", total: files.length, files });
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  // Sequential on purpose: libx264 already uses every CPU core.
  for (const [index, name] of files.entries()) {
    if (signal.aborted) break;
    try {
      if ((await convertOne(index, name, opts, emit, signal)) === "skipped") skipped++;
      else completed++;
    } catch (err) {
      failed++;
      const message = signal.aborted
        ? "Cancelled"
        : isMissingBinary(err)
          ? "FFmpeg/FFprobe not found on PATH"
          : err instanceof Error
            ? err.message
            : String(err);
      emit({ type: "file", index, name, status: "error", message });
    }
  }

  emit({ type: "done", completed, skipped, failed });
}

/**
 * macOS: keep the Mac awake while a batch runs. `-w` ties caffeinate to this
 * Node process, so it also exits if the server is stopped mid-batch.
 */
function preventSleep(): () => void {
  if (process.platform !== "darwin") return () => {};
  try {
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", () => {}); // not fatal if caffeinate is unavailable
    return () => child.kill();
  } catch {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * All .mxf files under `root`, including subfolders, as paths relative to
 * `root`, sorted folder by folder. Skips hidden files and folders (macOS
 * "._C0001.MXF" metadata files on exFAT drives, .Trashes, …), symlinks, and
 * the destination folder if it sits inside the source.
 */
async function findMxfFiles(root: string, destination: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (full !== destination) await walk(full, relPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === INPUT_EXTENSION) {
        found.push(relPath);
      }
    }
  }
  await walk(root, "");
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function badRequest(error: string) {
  return Response.json({ error }, { status: 400 });
}

export async function POST(request: Request) {
  let body: Partial<ConvertRequest>;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be JSON.");
  }

  const sourceRaw = body.source?.trim();
  const destinationRaw = body.destination?.trim();
  const mode = body.mode ?? "auto";
  const skipExisting = body.skipExisting ?? true;
  if (!sourceRaw || !destinationRaw) return badRequest("Source and destination folders are required.");
  if (!MODES.includes(mode)) return badRequest(`Unknown mode "${mode}".`);
  if (!path.isAbsolute(sourceRaw) || !path.isAbsolute(destinationRaw)) {
    return badRequest(
      `Use absolute paths for this OS (${process.platform === "win32" ? "e.g. D:\\RawFiles" : "e.g. /Users/you/RawFiles"}).`,
    );
  }
  const source = path.resolve(sourceRaw);
  const destination = path.resolve(destinationRaw);

  try {
    if (!(await fs.stat(source)).isDirectory()) return badRequest(`Not a folder: ${source}`);
  } catch {
    return badRequest(`Source folder not found: ${source}`);
  }
  try {
    await fs.mkdir(destination, { recursive: true });
  } catch (err) {
    return badRequest(`Cannot create destination folder: ${(err as Error).message}`);
  }

  for (const bin of [FFMPEG, FFPROBE]) {
    try {
      await run(bin, ["-version"]);
    } catch {
      return badRequest(
        `"${bin}" is not installed or not on PATH. Install FFmpeg (macOS: brew install ffmpeg, Windows: winget install Gyan.FFmpeg) or set FFMPEG_PATH / FFPROBE_PATH.`,
      );
    }
  }

  const files = await findMxfFiles(source, destination);
  if (files.length === 0) return badRequest(`No .mxf files found in ${source} or its subfolders`);

  // Stop work if the browser disconnects or the user presses Cancel.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ConvertEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // Stream already closed by the client; keep going quietly.
        }
      };
      const allowSleep = preventSleep();
      try {
        await convertAll(files, { source, destination, mode, skipExisting }, emit, abort.signal);
      } catch (err) {
        emit({ type: "fatal", message: err instanceof Error ? err.message : String(err) });
      } finally {
        allowSleep();
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // no-transform stops gzip from buffering the stream.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
