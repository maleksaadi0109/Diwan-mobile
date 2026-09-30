import { existsSync } from "node:fs";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";

const MARKER = ".mobile-temporary";
const RETENTION_MS = 24 * 60 * 60 * 1000;

export async function markTemporary(dir: string): Promise<void> {
  await writeFile(path.join(dir, MARKER), "");
}

/** Only delete files created under the new temporary-import policy.
 * Pre-existing local recordings have no marker and must not be deleted. */
export async function cleanupTemporaryAudio(root: string): Promise<void> {
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const marker = await stat(path.join(dir, MARKER));
      if (Date.now() - marker.mtimeMs > RETENTION_MS) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      // Missing marker means legacy content. Other errors must remain visible.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function scheduleTemporaryAudioCleanup(root: string): void {
  const sweep = () => void cleanupTemporaryAudio(root).catch((error) =>
    logger.error({ error }, "Could not clean temporary audio"));
  setTimeout(sweep, 10_000).unref();
  setInterval(sweep, 60 * 60 * 1000).unref();
}