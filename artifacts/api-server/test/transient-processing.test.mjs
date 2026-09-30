import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const artifact = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(artifact, "../..");
const port = 29185;
const base = `http://127.0.0.1:${port}/api`;
let server;

async function start(worker) {
  server = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: artifact, env: { ...process.env, PORT: String(port), PYTHON: worker },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  server.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Server failed: ${errors}`);
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${errors}`);
}

async function stop() {
  if (!server) return;
  const child = server;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  server = undefined;
}

test("processing is temporary; completed audio must be cached by the phone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diwan-transient-test-"));
  const id = `test-${randomUUID().replace(/-/g, "")}`;
  const audioDir = path.join(workspace, ".data", "diwan-youtube", id);
  try {
    await mkdir(path.join(audioDir, "final"), { recursive: true });
    await writeFile(path.join(audioDir, "final", "processing.wav"), "processing");
    await writeFile(path.join(audioDir, "final", "playback.mp3"), "phone-audio");
    const worker = path.join(dir, "fake-worker");
    await writeFile(worker, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  console.log(JSON.stringify({success:true,data:{alignments:request.payload.verses.map(v => ({
    verse_id:v.id,start_ms:0,end_ms:100,confidence:0.9
  }))}}));
});`, { mode: 0o755 });
    await start(worker);
    const invalid = await fetch(`${base}/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_path: "/etc/passwd", verses: [{ id: "verse-1", text: "نص" }],
        poem_id: "poem-1", recording_id: "rec-1",
      }),
    });
    assert.equal(invalid.status, 400);
    const created = await fetch(`${base}/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_path: `/api-worker/youtube/audio/${id}/processing.wav`,
        verses: [{ id: "verse-1", text: "نص" }],
        poem_id: "poem-1", recording_id: "rec-1",
      }),
    });
    assert.equal(created.status, 202);
    const jobId = (await created.json()).job_id;
    let result;
    for (let i = 0; i < 100; i++) {
      result = await (await fetch(`${base}/jobs/${jobId}`)).json();
      if (result.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(result.status, "succeeded");
    assert.equal(result.result.alignments[0].verse_id, "verse-1");
    const audio = await fetch(`${base}/youtube/audio/${id}/playback.mp3`, {
      headers: { Range: "bytes=6-10" },
    });
    assert.equal(audio.status, 206);
    assert.equal(await audio.text(), "audio");
    await stop();
    await start(worker);
    assert.equal((await fetch(`${base}/jobs/${jobId}`)).status, 404);
  } finally {
    await stop();
    await rm(audioDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("sample server work survives a disconnected phone and can be looked up after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diwan-sample-test-"));
  const id = `yt-sample-${randomUUID().replace(/-/g, "")}`;
  const audioDir = path.join(workspace, ".data", "diwan-youtube", id);
  try {
    const worker = path.join(dir, "fake-worker");
    await writeFile(worker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const { payload } = JSON.parse(input);
  setTimeout(() => {
    const final = path.join(payload.output_dir, payload.job_id, 'final');
    fs.mkdirSync(final, { recursive: true });
    fs.writeFileSync(path.join(final, 'playback.mp3'), 'real-audio');
    console.log(JSON.stringify({success:true,data:{duration_ms:4200}}));
  }, 150);
});`, { mode: 0o755 });
    await start(worker);
    const controller = new AbortController();
    const request = fetch(`${base}/youtube/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Diwan-Temporary-Audio": "1" },
      body: JSON.stringify({ url: "https://youtube.test/watch?v=test", job_id: id }),
      signal: controller.signal,
    }).catch(() => undefined);
    for (let i = 0; i < 30; i++) {
      const status = await fetch(`${base}/youtube/download/${id}/status`);
      if (status.status === 202) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    await request;
    let status;
    for (let i = 0; i < 40; i++) {
      status = await fetch(`${base}/youtube/download/${id}/status`);
      if (status.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(status.status, 200);
    assert.equal((await status.json()).duration_ms, 4200);
    await stop();
    await start(worker);
    assert.equal((await fetch(`${base}/youtube/download/${id}/status`)).status, 200);
    assert.equal((await fetch(`${base}/youtube/audio/${id}/playback.mp3`)).status, 200);
  } finally {
    await stop();
    await rm(audioDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("audio work rejects excess clients without blocking status polling or three sample downloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "diwan-limits-test-"));
  const ids = [];
  try {
    const worker = path.join(dir, "fake-worker");
    await writeFile(worker, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const { payload } = JSON.parse(input);
  setTimeout(() => console.log(JSON.stringify({success:true,data:{duration_ms:4200}})),
    payload.url?.includes('hold') ? 1200 : 5);
});`, { mode: 0o755 });
    await start(worker);
    const download = (id, ip = "192.0.2.1", hold = false) => fetch(`${base}/youtube/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, "X-Diwan-Temporary-Audio": "1" },
      body: JSON.stringify({ url: `https://youtube.test/watch?v=${hold ? "hold" : "test"}`, job_id: id }),
    });
    const id = () => {
      const value = `yt-sample-${randomUUID().replace(/-/g, "")}`;
      ids.push(value);
      return value;
    };
    for (const url of ["not a URL", "http://ytimg.com/image.jpg", "https://untrusted.example/image.jpg"]) {
      const invalid = await fetch(`${base}/youtube/thumbnail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      assert.equal(invalid.status, 400);
    }
    // Rejected thumbnail URLs must not consume worker capacity.
    const firstId = id();
    const first = download(firstId, "192.0.2.1", true);
    for (let i = 0; i < 40; i++) {
      if ((await fetch(`${base}/youtube/download/${firstId}/status`)).status === 202) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const secondId = id();
    const second = download(secondId, "192.0.2.1", true);
    for (let i = 0; i < 40; i++) {
      if ((await fetch(`${base}/youtube/download/${secondId}/status`)).status === 202) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sameClient = await download(id());
    assert.equal(sameClient.status, 429);
    assert.equal((await sameClient.json()).error_code, "CLIENT_BUSY");
    assert.equal(sameClient.headers.get("retry-after"), "5");
    const thirdId = id();
    const third = download(thirdId, "192.0.2.2", true);
    for (let i = 0; i < 40; i++) {
      if ((await fetch(`${base}/youtube/download/${thirdId}/status`)).status === 202) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const globalBusy = await download(id(), "192.0.2.3");
    assert.equal(globalBusy.status, 503);
    assert.equal((await globalBusy.json()).error_code, "SERVER_BUSY");
    assert.equal((await fetch(`${base}/youtube/download/${firstId}/status`)).status, 202);
    const audioDir = path.join(workspace, ".data", "diwan-youtube", firstId, "final");
    await mkdir(audioDir, { recursive: true });
    await writeFile(path.join(audioDir, "processing.wav"), "audio");
    const createJob = () => fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.4" },
      body: JSON.stringify({
        audio_path: `/api-worker/youtube/audio/${firstId}/processing.wav`,
        verses: [{ id: "verse-1", text: "نص" }], poem_id: "poem-1", recording_id: "rec-1",
      }),
    });
    const queued = await createJob();
    assert.equal(queued.status, 202);
    const queuedId = (await queued.json()).job_id;
    assert.equal((await createJob()).status, 202);
    const tooManyJobs = await createJob();
    assert.equal(tooManyJobs.status, 429);
    assert.equal((await tooManyJobs.json()).error_code, "CLIENT_BUSY");
    assert.equal((await (await fetch(`${base}/jobs/${queuedId}`)).json()).status, "queued");
    assert.deepEqual((await Promise.all([first, second, third])).map((response) => response.status), [200, 200, 200]);
    let jobStatus;
    for (let i = 0; i < 40; i++) {
      jobStatus = (await (await fetch(`${base}/jobs/${queuedId}`)).json()).status;
      if (jobStatus === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(jobStatus, "succeeded");
    // The same phone can cache three samples in one session.
    assert.equal((await download(id())).status, 200);
    // The limit applies to new work, not reconnection/status polling.
    for (let i = 0; i < 8; i++) await download(id());
    const limited = await download(id());
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error_code, "RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await fetch(`${base}/youtube/download/${firstId}/status`)).status, 200);
  } finally {
    await stop();
    await Promise.all(ids.map((jobId) =>
      rm(path.join(workspace, ".data", "diwan-youtube", jobId), { recursive: true, force: true })));
    await rm(dir, { recursive: true, force: true });
  }
});