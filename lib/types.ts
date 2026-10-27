// Shared between app/api/convert/route.ts and app/page.tsx.

export type ConversionMode = "auto" | "mp3" | "mp4";

export interface ConvertRequest {
  source: string;
  destination: string;
  mode: ConversionMode;
  /** Skip files whose output already exists and is complete (resume). Default true. */
  skipExisting?: boolean;
}

/** What ffprobe decided the file is. */
export type DetectedType = "video" | "audio-only" | "unknown";

export type FileStatus = "queued" | "probing" | "processing" | "completed" | "skipped" | "error";

export interface FileUpdate {
  index: number;
  name: string;
  status?: FileStatus;
  detected?: DetectedType;
  format?: "mp4" | "mp3";
  /** Encoder settings used, e.g. "ffmpeg libx264 CRF 23 + AAC 320k". */
  pipeline?: string;
  output?: string;
  /** 0–100 while processing, when the duration is known. */
  percent?: number;
  message?: string;
}

/** The API streams these as newline-delimited JSON (one object per line). */
export type ConvertEvent =
  | {
      type: "start";
      total: number;
      files: string[];
      /** Subfolders that couldn't be opened (e.g. permission denied) and were skipped. */
      unreadable: string[];
    }
  | ({ type: "file" } & FileUpdate)
  | { type: "done"; completed: number; skipped: number; failed: number }
  | { type: "fatal"; message: string };
