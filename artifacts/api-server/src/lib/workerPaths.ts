import { existsSync } from "node:fs";
import path from "node:path";

const workerPathCandidates = [
  path.resolve(process.cwd(), "artifacts", "api-server", "worker"),
  path.resolve(process.cwd(), "api-server", "worker"),
  path.resolve(process.cwd(), "worker"),
];

export const workerPath = workerPathCandidates.find(existsSync);

if (!workerPath) {
  throw new Error("API audio worker directory was not found");
}

export const workspaceRoot = path.resolve(workerPath, "..", "..", "..");
export const downloadRoot = path.join(workspaceRoot, ".data", "diwan-youtube");