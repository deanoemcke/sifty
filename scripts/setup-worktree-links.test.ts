import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureSharedSymlink,
  getMainRepoRoot,
  isGitWorktree,
} from './setup-worktree-links';

function createFixtureRepoWithWorktree(): { mainRepoRoot: string; worktreeRoot: string } {
  const containerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-worktree-fixture-')));
  const mainRepoRoot = path.join(containerDir, 'main');
  const worktreeRoot = path.join(containerDir, 'worktree');
  fs.mkdirSync(mainRepoRoot);

  execFileSync('git', ['init', '-q'], { cwd: mainRepoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'init', '--allow-empty'], { cwd: mainRepoRoot });
  execFileSync('git', ['worktree', 'add', '-q', '--detach', worktreeRoot], { cwd: mainRepoRoot });

  return { mainRepoRoot, worktreeRoot };
}

describe('isGitWorktree / getMainRepoRoot', () => {
  let mainRepoRoot: string;
  let worktreeRoot: string;

  afterEach(() => {
    if (!mainRepoRoot) return;
    execFileSync('git', ['worktree', 'remove', '-f', worktreeRoot], { cwd: mainRepoRoot });
    fs.rmSync(path.dirname(mainRepoRoot), { recursive: true });
  });

  it('recognises a real git worktree checkout as a worktree', () => {
    ({ mainRepoRoot, worktreeRoot } = createFixtureRepoWithWorktree());
    expect(isGitWorktree(worktreeRoot)).toBe(true);
  });

  it('does not recognise the main repo checkout as a worktree', () => {
    ({ mainRepoRoot, worktreeRoot } = createFixtureRepoWithWorktree());
    expect(isGitWorktree(mainRepoRoot)).toBe(false);
  });

  it('resolves the main repo root from within a worktree', () => {
    ({ mainRepoRoot, worktreeRoot } = createFixtureRepoWithWorktree());
    expect(getMainRepoRoot(worktreeRoot)).toBe(mainRepoRoot);
    expect(fs.existsSync(path.join(mainRepoRoot, '.git'))).toBe(true);
  });
});

describe('ensureSharedSymlink', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true });
  });

  it('creates a symlink when nothing exists at the link path', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-link-test-'));
    const linkPath = path.join(tmpRoot, 'worktree', '.claude', 'reviews');
    const targetDir = path.join(tmpRoot, 'main', '.claude', 'reviews');

    const result = ensureSharedSymlink(linkPath, targetDir);

    expect(result).toBe('created');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(targetDir));
  });

  it('is idempotent — running again on an already-correct symlink reports already-linked', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-link-test-'));
    const linkPath = path.join(tmpRoot, 'worktree', 'data');
    const targetDir = path.join(tmpRoot, 'main', 'data');

    ensureSharedSymlink(linkPath, targetDir);
    const result = ensureSharedSymlink(linkPath, targetDir);

    expect(result).toBe('already-linked');
  });

  it('does not touch a real (non-symlink) directory that already holds data', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sifty-link-test-'));
    const linkPath = path.join(tmpRoot, 'worktree', 'data');
    const targetDir = path.join(tmpRoot, 'main', 'data');
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(path.join(linkPath, 'sifty.db'), 'pre-existing data');

    const result = ensureSharedSymlink(linkPath, targetDir);

    expect(result).toBe('skipped-existing-data');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linkPath, 'sifty.db'), 'utf8')).toBe('pre-existing data');
  });
});
