import { statSync } from "node:fs";
import path from "node:path";

/** Never trust a client-provided filesystem path; only known converted files. */
export function resolveLocalAudio(downloadRoot: string, value: unknown): string {
  const match = typeof value === "string"
    ? /^\/api-worker\/youtube\/audio\/([a-zA-Z0-9_-]{1,80})\/(processing\.wav|playback\.mp3)$/.exec(value)
    : null;
  if (!match) throw new Error("audio_path must refer to audio converted by this API");
  const filename = path.join(downloadRoot, match[1], "final", match[2]);
  try {
    const file = statSync(filename);
    if (file.isFile() && file.size > 0 && file.size <= 500 * 1024 * 1024) return filename;
  } catch { /* Missing after a server restart or temporary file cleanup. */ }
  throw new Error("Converted audio is no longer available; start the import again");
}