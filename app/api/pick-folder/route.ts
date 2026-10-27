import { promises as fs } from "node:fs";
import path from "node:path";
import { isMissingBinary, lastLines, run, type RunResult } from "@/lib/run";

// A browser can't reveal a folder's absolute path, but this server runs on the
// user's own machine, so it opens the OS's native folder dialog instead.
// The prompt and default folder are passed as arguments / env vars, never
// spliced into script source.

const MAC_SCRIPT = [
  "on run argv",
  "activate", // bring the dialog in front of the browser
  "set promptText to item 1 of argv",
  "try",
  "set startAt to POSIX file (item 2 of argv) as alias",
  "return POSIX path of (choose folder with prompt promptText default location startAt)",
  "on error number errNum",
  "if errNum is -128 then error number -128", // user pressed Cancel
  "return POSIX path of (choose folder with prompt promptText)", // default folder missing
  "end try",
  "end run",
];

const WINDOWS_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = $env:PICK_PROMPT",
  "$d.ShowNewFolderButton = $true",
  "if ($env:PICK_DEFAULT -and (Test-Path -LiteralPath $env:PICK_DEFAULT)) { $d.SelectedPath = $env:PICK_DEFAULT }",
  "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }",
  "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
].join("; ");

async function openDialog(prompt: string, startAt: string, signal: AbortSignal): Promise<RunResult> {
  switch (process.platform) {
    case "darwin":
      return run(
        "osascript",
        [...MAC_SCRIPT.flatMap((line) => ["-e", line]), prompt, startAt || "/"],
        { signal },
      );
    case "win32":
      return run("powershell.exe", ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT], {
        signal,
        env: { ...process.env, PICK_PROMPT: prompt, PICK_DEFAULT: startAt },
      });
    default:
      return run(
        "zenity",
        ["--file-selection", "--directory", `--title=${prompt}`, ...(startAt ? [`--filename=${startAt}/`] : [])],
        { signal },
      );
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { title?: string; current?: string };
  const prompt = body.title?.trim() || "Select a folder";

  // Start the dialog in the folder already typed in, if it exists.
  let startAt = "";
  const current = body.current?.trim();
  if (current && path.isAbsolute(current)) {
    startAt = await fs.stat(current).then((s) => (s.isDirectory() ? current : ""), () => "");
  }

  let res: RunResult;
  try {
    res = await openDialog(prompt, startAt, request.signal);
  } catch (err) {
    const message = isMissingBinary(err)
      ? "No folder dialog available on this system (Linux needs zenity). Type the path instead."
      : (err as Error).message;
    return Response.json({ error: message }, { status: 500 });
  }

  const picked = res.stdout.trim();
  // macOS: Cancel exits 1 with error -128. Windows: empty output. zenity: exit 1.
  if (!picked) {
    if (res.code === 0 || res.code === 1) return Response.json({ cancelled: true });
    return Response.json({ error: lastLines(res.stderr) }, { status: 500 });
  }

  // macOS returns "/Users/me/Folder/"; drop the trailing separator (but keep "/" or "D:\").
  const folder = picked.length > 1 && /[\\/]$/.test(picked) && !/^[A-Za-z]:\\$/.test(picked)
    ? picked.slice(0, -1)
    : picked;
  return Response.json({ path: folder });
}
