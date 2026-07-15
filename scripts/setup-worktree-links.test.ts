import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureSharedSymlink,
  getMainRepoRoot,
  isGitWorktree,
} from './setup-worktree-links';

describe('isGitWorktree / getMainRepoRoot', () => {
  it('recognises the current checkout as a git worktree', () => {
    expect(isGitWorktree(process.cwd())).toBe(true);
  });

  it('resolves the main repo root to the checkout without a .worktrees suffix', () => {
    const mainRepoRoot = getMainRepoRoot(process.cwd());
    expect(mainRepoRoot).not.toContain('.worktrees');
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
