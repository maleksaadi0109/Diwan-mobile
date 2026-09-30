import type { Request, Response, RequestHandler } from "express";

// These limits are per server process. Do not trust client-supplied identity headers;
// req.ip is derived from the single trusted deployment proxy in app.ts.
const WINDOW_MS = 10 * 60_000;
const MAX_ACTIVE = 3;
const MAX_CLIENT_ACTIVE = 2;
const counts = new Map<string, { count: number; resetAt: number }>();
const activeByClient = new Map<string, number>();
const availableListeners = new Set<() => void>();
let active = 0;

export function rateLimit(bucket: "processing" | "metadata"): RequestHandler {
  const maximum = bucket === "processing" ? 12 : 30;
  return (req, res, next) => {
    const now = Date.now();
    const key = `${bucket}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    // Expired keys are pruned on demand, keeping the map bounded over time.
    for (const [client, entry] of counts) {
      if (entry.resetAt <= now) counts.delete(client);
    }
    const entry = counts.get(key) ?? { count: 0, resetAt: now + WINDOW_MS };
    if (entry.count >= maximum) {
      const seconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(seconds));
      res.status(429).json({ error_code: "RATE_LIMITED", error_message: "Too many audio requests; try again later" });
      return;
    }
    entry.count++;
    counts.set(key, entry);
    next();
  };
}

export function tryAcquire(client: string): (() => void) | undefined {
  if (active >= MAX_ACTIVE || (activeByClient.get(client) ?? 0) >= MAX_CLIENT_ACTIVE) return undefined;
  active++;
  activeByClient.set(client, (activeByClient.get(client) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    const remaining = (activeByClient.get(client) ?? 1) - 1;
    if (remaining) activeByClient.set(client, remaining);
    else activeByClient.delete(client);
    for (const listener of availableListeners) listener();
  };
}

export function onWorkAvailable(listener: () => void): void {
  availableListeners.add(listener);
}

export function acquireWork(req: Request, res: Response): (() => void) | undefined {
  const client = req.ip || req.socket.remoteAddress || "unknown";
  const release = tryAcquire(client);
  if (!release) {
    const clientBusy = (activeByClient.get(client) ?? 0) >= MAX_CLIENT_ACTIVE;
    res.setHeader("Retry-After", "5");
    res.status(clientBusy ? 429 : 503).json({
      error_code: clientBusy ? "CLIENT_BUSY" : "SERVER_BUSY",
      error_message: "Audio processing is busy; try again shortly",
    });
  }
  return release;
}