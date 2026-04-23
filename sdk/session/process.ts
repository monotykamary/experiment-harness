/**
 * Low-level process management for experiment runs.
 *
 * Provides process spawning with timeout/kill-tree semantics,
 * output streaming to temp files, and temp file allocation.
 * No dependency on Session state — pure utilities.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Process tree management
// ---------------------------------------------------------------------------

/** Kill a process tree (best effort). Sends SIGTERM to the process group. */
export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

// ---------------------------------------------------------------------------
// Temp file allocation
// ---------------------------------------------------------------------------

/**
 * Lazy temp file allocator.
 * Uses OS tmpdir and crypto-random IDs (matching pi-autoresearch).
 * Returns the same path on repeated calls (single-file per allocator).
 */
export function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(os.tmpdir(), `experiment-${id}.log`);
    }
    return p;
  };
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

export interface SpawnProcessOptions {
  /** Shell command to run. */
  command: string;
  /** Working directory for the child process. */
  cwd: string;
  /** Timeout in milliseconds. 0 = no timeout. */
  timeout: number;
  /** Temp file path allocator for large output. */
  tempFileAllocator: () => string;
}

export interface SpawnResult {
  exitCode: number | null;
  killed: boolean;
  output: string;
  tempFilePath: string | undefined;
  actualTotalBytes: number;
}

/**
 * Spawn a bash process, capture stdout+stderr with rolling buffer,
 * and stream to a temp file if output exceeds 50KB.
 *
 * Resolves when the process exits (or is killed on timeout).
 */
export function spawnProcess(opts: SpawnProcessOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let processTimedOut = false;

    const child = spawn("bash", ["-c", opts.command], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = 100 * 1024; // 100KB rolling buffer

    let tempFilePath: string | undefined;
    let tempFileStream: ReturnType<typeof fs.createWriteStream> | undefined;
    let totalBytes = 0;

    const handleData = (data: Buffer) => {
      totalBytes += data.length;

      if (totalBytes > 50000 && !tempFilePath) {
        tempFilePath = opts.tempFileAllocator();
        tempFileStream = fs.createWriteStream(tempFilePath);
        for (const chunk of chunks) {
          tempFileStream.write(chunk);
        }
      }

      if (tempFileStream) {
        tempFileStream.write(data);
      }

      chunks.push(data);
      chunksBytes += data.length;

      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
    };

    if (child.stdout) child.stdout.on("data", handleData);
    if (child.stderr) child.stderr.on("data", handleData);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        processTimedOut = true;
        if (child.pid) killTree(child.pid);
      }, opts.timeout);
    }

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (tempFileStream) tempFileStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (tempFileStream) tempFileStream.end();

      const fullBuffer = Buffer.concat(chunks);
      resolve({
        exitCode: code,
        killed: processTimedOut,
        output: fullBuffer.toString("utf-8"),
        tempFilePath,
        actualTotalBytes: totalBytes,
      });
    });
  });
}
