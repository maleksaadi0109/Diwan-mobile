import { Router, type IRouter } from "express";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveLocalAudio } from "../lib/localAudio";
import { downloadRoot, workerPath, workspaceRoot } from "../lib/workerPaths";
import { onWorkAvailable, rateLimit, tryAcquire } from "../lib/workLimits";

const router: IRouter = Router();
const MAX_RUNTIME = 5 * 60_000;
const RETENTION = 30 * 60_000;

type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled";
interface Input {
  audioPath: string;
  verses: { id: string; text: string }[];
  poemId: string;
  recordingId: string;
}
interface Job {
  id: string;
  client: string;
  status: Status;
  input: Input;
  updatedAt: number;
  progress?: number;
  result?: Record<string, unknown>;
  error?: string;
  child?: ChildProcessWithoutNullStreams;
}
const jobs = new Map<string, Job>();
const queue: string[] = [];
let running = false;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 100 &&
  /^[\p{L}\p{N}_.:-]+$/u.test(value);

function validate(body: unknown): Input {
  if (!body || typeof body !== "object") throw new Error("Request body must be an object");
  const data = body as Record<string, unknown>;
  if (!identifier(data.poem_id) || !identifier(data.recording_id)) throw new Error("Invalid poem or recording ID");
  if (!Array.isArray(data.verses) || data.verses.length < 1 || data.verses.length > 200) {
    throw new Error("verses must contain between 1 and 200 items");
  }
  let total = 0;
  const verses = data.verses.map((item: unknown) => {
    const verse = item as Record<string, unknown>;
    if (!verse || !identifier(verse.id) || typeof verse.text !== "string" ||
      !verse.text.trim() || verse.text.length > 500) throw new Error("Invalid verse");
    total += verse.text.length;
    return { id: verse.id, text: verse.text };
  });
  if (total > 20_000) throw new Error("Verse text exceeds size limit");
  const audioPath = resolveLocalAudio(downloadRoot, data.audio_path);
  return { audioPath, verses, poemId: data.poem_id, recordingId: data.recording_id };
}

function publicJob(job: Job) {
  return {
    job_id: job.id, status: job.status,
    ...(job.progress === undefined ? {} : { progress: job.progress }),
    ...(job.status === "succeeded" ? { result: job.result } : {}),
    ...(job.status === "failed" ? { error_message: job.error } : {}),
  };
}

function prune() {
  const cutoff = Date.now() - RETENTION;
  for (const [id, job] of jobs) {
    if (!["queued", "running"].includes(job.status) && job.updatedAt < cutoff) jobs.delete(id);
  }
}

function stop(child: ChildProcessWithoutNullStreams) {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
}

function processJob(job: Job, release: () => void): void {
  job.status = "running";
  job.updatedAt = Date.now();
  job.progress = 0;
  const child = spawn(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-m", "diwan_worker.cli"], {
      cwd: workspaceRoot,
      env: { ...process.env, PYTHONPATH: workerPath, PYTHONIOENCODING: "utf-8:backslashreplace", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  job.child = child;
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let outcome: { status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string } | undefined;
  const timer = setTimeout(() => { outcome = { status: "failed", error: "Alignment timed out" }; stop(child); }, MAX_RUNTIME);
  timer.unref();
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { outcome = { status: "failed", error: "Worker output too large" }; stop(child); return; }
    stdout += chunk.toString("utf8");
    const lines = stdout.split("\n");
    stdout = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "progress" && Number.isFinite(event.progress)) {
          job.progress = Math.max(0, Math.min(1, event.progress));
          job.updatedAt = Date.now();
        } else if (event.success === true && event.data && typeof event.data === "object") {
          outcome = { status: "succeeded", result: event.data };
        } else if (event.success === false) {
          outcome = { status: "failed", error: `${event.error_code || ""}: ${event.error_message || "Alignment failed"}` };
        }
      } catch { /* Ignore worker diagnostic output. */ }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-1000); });
  child.on("error", (error) => { outcome = { status: "failed", error: error.message }; });
  child.on("close", (code) => {
    clearTimeout(timer);
    job.child = undefined;
    if (job.status !== "cancelled") {
      const final = outcome || { status: "failed", error: `Worker exited (${code}): ${stderr}` };
      job.status = final.status;
      job.result = final.result;
      job.error = final.error?.slice(0, 1000);
      job.progress = final.status === "succeeded" ? 1 : job.progress;
      job.updatedAt = Date.now();
    }
    running = false;
    release();
    pump();
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({
    id: `api-align-${randomUUID()}`, command: "align",
    payload: {
      audio_path: job.input.audioPath, verses: job.input.verses,
      poem_id: job.input.poemId, recording_id: job.input.recordingId, mock: false,
    },
  }) + "\n");
}

function pump(): void {
  if (running) return;
  for (let remaining = queue.length; remaining > 0; remaining--) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (job?.status !== "queued") continue;
    const release = tryAcquire(job.client);
    if (!release) {
      queue.push(id);
      continue;
    }
    running = true;
    processJob(job, release);
    break;
  }
}
onWorkAvailable(pump);

router.post("/jobs", rateLimit("processing"), (req, res) => {
  let input: Input;
  try { input = validate(req.body); }
  catch (error) {
    res.status(400).json({ error_message: error instanceof Error ? error.message : "Invalid job input" }); return;
  }
  prune();
  if (jobs.size >= 100 || queue.length >= 20) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({ error_code: "SERVER_BUSY", error_message: "Job capacity is temporarily full" }); return;
  }
  const client = req.ip || req.socket.remoteAddress || "unknown";
  if ([...jobs.values()].filter((job) =>
    job.client === client && (job.status === "queued" || job.status === "running")).length >= 2) {
    res.setHeader("Retry-After", "5");
    res.status(429).json({ error_code: "CLIENT_BUSY", error_message: "Too many active audio jobs" }); return;
  }
  const job: Job = { id: randomUUID(), client, status: "queued", input, updatedAt: Date.now() };
  jobs.set(job.id, job);
  queue.push(job.id);
  res.status(202).json(publicJob(job));
  pump();
});
router.get("/jobs/:id", (req, res) => {
  prune();
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error_message: "Job not found or expired" }); return; }
  res.json(publicJob(job));
});
router.post("/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error_message: "Job not found or expired" }); return; }
  if (job.status === "queued" || job.status === "running") {
    job.status = "cancelled";
    job.updatedAt = Date.now();
    if (job.child) stop(job.child);
  }
  res.json(publicJob(job));
});

export default router;