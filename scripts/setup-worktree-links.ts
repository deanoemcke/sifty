/**
 * Ensures .claude/reviews and .cache are symlinked to the main repo's copies when running
 * inside a git worktree, so peer-review reports and the SQLite cache are shared instead of
 * silently diverging per worktree. Runs automatically via the postinstall npm script, since
 * every new worktree already requires `npm install` as its first setup step.
 *
 * Safe by default: never overwrites a real (non-symlink) file or directory that already
 * holds data — it only creates the symlink when nothing exists at that path yet.
 * Run with: npx tsx scripts/setup-worktree-links.ts
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const LINKED_PATHS = ['.claude/reviews', '.cache'];

export function getGitCommonDir(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
}

export function getGitDir(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' }).trim();
}

export function isGitWorktree(cwd: string): boolean {
  return path.resolve(cwd, getGitCommonDir(cwd)) !== path.resolve(cwd, getGitDir(cwd));
}

// --git-common-dir always resolves to "<mainRepoRoot>/.git", including from within a worktree.
export function getMainRepoRoot(cwd: string): string {
  return path.dirname(path.resolve(cwd, getGitCommonDir(cwd)));
}

export type LinkResult = 'created' | 'already-linked' | 'skipped-existing-data';

export function ensureSharedSymlink(linkPath: string, targetDir: string): LinkResult {
  fs.mkdirSync(targetDir, { recursive: true });

  let existingStat: fs.Stats | undefined;
  try {
    existingStat = fs.lstatSync(linkPath);
  } catch {
    existingStat = undefined;
  }

  if (existingStat === undefined) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(targetDir, linkPath, 'dir');
    return 'created';
  }

  if (existingStat.isSymbolicLink() && fs.realpathSync(linkPath) === fs.realpathSync(targetDir)) {
    return 'already-linked';
  }

  return 'skipped-existing-data';
}

export function setupWorktreeLinks(cwd: string): void {
  if (!isGitWorktree(cwd)) {
    console.log('[setup-worktree-links] Not running in a worktree — skipping.');
    return;
  }

  const mainRepoRoot = getMainRepoRoot(cwd);

  for (const relativePath of LINKED_PATHS) {
    const linkPath = path.join(cwd, relativePath);
    const targetDir = path.join(mainRepoRoot, relativePath);
    const result = ensureSharedSymlink(linkPath, targetDir);

    if (result === 'created') {
      console.log(`[setup-worktree-links] Linked ${relativePath} -> ${targetDir}`);
    } else if (result === 'skipped-existing-data') {
      console.warn(
        `[setup-worktree-links] ${relativePath} already exists as real data in this worktree — ` +
          `leaving it alone. Reconcile manually with ${targetDir} and re-run if you want it shared.`,
      );
    }
  }
}

if (require.main === module) {
  setupWorktreeLinks(process.cwd());
}
