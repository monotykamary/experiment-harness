/**
 * Git worktree management for experiment isolation.
 *
 * Creates isolated worktrees at <cwd>/autoresearch/<sessionId>/,
 * auto-adds `autoresearch/` to the global gitignore, and provides
 * commit/revert operations that preserve autoresearch files.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

/** Files that should survive a git revert (autoresearch state). */
const PROTECTED_FILES = [
  "autoresearch.jsonl",
  "autoresearch.md",
  "autoresearch.ideas.md",
  "autoresearch.sh",
  "autoresearch.checks.sh",
];

/** Get the path to the global gitignore file. */
function getGlobalGitignorePath(): string | null {
  try {
    const result = execFileSync("git", ["config", "--global", "core.excludesfile"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const configured = result.trim();
    if (configured) return configured;
  } catch {
    // Not configured, fall through to default
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(home, ".gitignore"),
    path.join(home, ".gitignore_global"),
    path.join(home, ".config", "git", "ignore"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return path.join(home, ".gitignore");
}

/** Ensure autoresearch/ is in the global gitignore. */
function ensureGlobalGitignore(): void {
  try {
    const gitignorePath = getGlobalGitignorePath();
    if (!gitignorePath) return;

    const pattern = "autoresearch/";
    let content = "";

    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
      if (content.split(/\r?\n/).some((line) => line.trim() === pattern)) {
        return;
      }
    }

    const parentDir = path.dirname(gitignorePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const entry = content.endsWith("\n") || content === ""
      ? `# pi-autoresearch worktrees\n${pattern}\n`
      : `\n# pi-autoresearch worktrees\n${pattern}\n`;

    fs.appendFileSync(gitignorePath, entry, "utf-8");
  } catch {
    // Silently fail — convenience, not a requirement
  }
}

/**
 * Run a git command in a working directory. Returns stdout.
 * Uses execFileSync to avoid shell injection.
 * Throws on non-zero exit code.
 */
export function git(cwd: string, args: string[], timeout: number = 10000): string {
  const result = execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.trim();
}

/**
 * Run a git command, returning { ok, stdout, code } instead of throwing.
 * Uses execFileSync to avoid shell injection.
 */
export function gitSafe(
  cwd: string,
  args: string[],
  timeout: number = 10000,
): { ok: boolean; stdout: string; code: number } {
  try {
    const result = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return { ok: true, stdout: result.trim(), code: 0 };
  } catch (e: any) {
    const stdout = (e?.stdout?.toString() ?? "") + (e?.stderr?.toString() ?? "");
    return {
      ok: false,
      stdout,
      code: e?.status ?? 1,
    };
  }
}

/** Get the current short commit hash. */
export function getHeadCommit(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--short=7", "HEAD"]);
  } catch {
    return "unknown";
  }
}

/** Create a git worktree for experiment isolation. */
export function createWorktree(
  repoCwd: string,
  sessionId: string,
): string | null {
  const worktreeName = `autoresearch/${sessionId}`;
  const worktreePath = path.join(repoCwd, worktreeName);

  // Check if worktree already exists
  const listResult = gitSafe(repoCwd, ["worktree", "list", "--porcelain"]);
  if (listResult.stdout.includes(worktreePath) && fs.existsSync(worktreePath)) {
    return worktreePath;
  }

  // Prune stale entries if worktree dir is missing
  if (listResult.stdout.includes(worktreePath) && !fs.existsSync(worktreePath)) {
    gitSafe(repoCwd, ["worktree", "prune"]);
  }

  // Create the autoresearch directory
  const autoresearchDir = path.join(repoCwd, "autoresearch");
  if (!fs.existsSync(autoresearchDir)) {
    fs.mkdirSync(autoresearchDir, { recursive: true });
  }

  const branchName = `autoresearch/${sessionId}`;

  // Create branch if it doesn't exist
  const branchResult = gitSafe(repoCwd, ["branch", "--list", branchName]);
  if (!branchResult.stdout.trim()) {
    const createResult = gitSafe(repoCwd, ["branch", branchName]);
    if (!createResult.ok) return null;
  }

  // Create worktree
  const worktreeResult = gitSafe(repoCwd, [
    "worktree",
    "add",
    worktreePath,
    branchName,
  ], 30000);

  if (!worktreeResult.ok) return null;

  // Ensure global gitignore ignores autoresearch worktrees
  ensureGlobalGitignore();

  return worktreePath;
}

/** Remove a git worktree and its associated branch. */
export function removeWorktree(repoCwd: string, worktreePath: string): void {
  gitSafe(repoCwd, ["worktree", "remove", "--force", worktreePath], 30000);
  const branchName = path.relative(repoCwd, worktreePath);
  gitSafe(repoCwd, ["branch", "-D", branchName]);

  // Clean up empty autoresearch directory
  try {
    const autoresearchDir = path.join(repoCwd, "autoresearch");
    if (fs.existsSync(autoresearchDir)) {
      const entries = fs.readdirSync(autoresearchDir);
      if (entries.length === 0) {
        fs.rmdirSync(autoresearchDir);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Commit all changes in the worktree with a descriptive message.
 * Returns the new commit hash or null on failure.
 */
export function commitChanges(
  workDir: string,
  message: string,
): string | null {
  const addResult = gitSafe(workDir, ["add", "-A"]);
  if (!addResult.ok) return null;

  // Check if there's anything to commit
  const diffResult = gitSafe(workDir, ["diff", "--cached", "--quiet"]);
  if (diffResult.ok) return null; // Nothing to commit

  const commitResult = gitSafe(workDir, ["commit", "-m", message]);
  if (!commitResult.ok) return null;

  return getHeadCommit(workDir);
}

/**
 * Revert changes in the worktree, preserving protected autoresearch files.
 * Uses execFileSync with proper argument arrays to avoid shell injection.
 */
export function revertChanges(workDir: string): boolean {
  try {
    // Stage protected files so they survive the checkout
    for (const f of PROTECTED_FILES) {
      const filePath = path.join(workDir, f);
      // Best-effort: add if it exists, ignore errors
      try {
        execFileSync("git", ["add", filePath], {
          cwd: workDir,
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        // File may not exist — that's fine
      }
    }

    // Revert tracked changes
    execFileSync("git", ["checkout", "--", "."], {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "ignore"],
    });

    // Remove untracked files (best-effort)
    try {
      execFileSync("git", ["clean", "-fd"], {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      // clean may fail if no untracked files — that's fine
    }

    return true;
  } catch {
    return false;
  }
}

/** Get the display path for a worktree (relative if inside project). */
export function getDisplayWorktreePath(
  repoCwd: string,
  worktreePath: string | null,
): string | null {
  if (!worktreePath) return null;
  if (worktreePath.startsWith(repoCwd)) {
    return path.relative(repoCwd, worktreePath) || ".";
  }
  return worktreePath;
}

/** Detect an existing autoresearch worktree by looking for autoresearch.jsonl. */
export function detectWorktree(
  repoCwd: string,
  sessionId?: string,
): string | null {
  try {
    const output = git(repoCwd, ["worktree", "list", "--porcelain"]);
    const lines = output.trim().split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        const worktreePath = line.slice(9).trim();

        if (sessionId) {
          const expectedSuffix = path.join("autoresearch", sessionId);
          if (!worktreePath.endsWith(expectedSuffix)) continue;
        }

        const jsonlPath = path.join(worktreePath, "autoresearch.jsonl");
        if (fs.existsSync(jsonlPath)) {
          return worktreePath;
        }
      }
    }
  } catch {
    // Git command failed or no worktrees
  }
  return null;
}

/** Get the list of protected autoresearch files. */
export function getProtectedFiles(): string[] {
  return [...PROTECTED_FILES];
}
