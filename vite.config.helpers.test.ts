import { describe, expect, it } from 'vitest';
import { getWorktreeLabel, getWorktreePort } from './vite.config.helpers';

describe('getWorktreePort', () => {
  it('returns the base port for the main worktree (no numeric suffix)', () => {
    expect(getWorktreePort('/Users/deanoemcke/Projects/sifty-webapp')).toBe(5173);
  });

  it('returns base port + suffix for a numbered worktree', () => {
    expect(getWorktreePort('/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp1')).toBe(
      5174
    );
    expect(getWorktreePort('/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp3')).toBe(
      5176
    );
  });

  it('ignores trailing slashes in the path', () => {
    expect(
      getWorktreePort('/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp2/')
    ).toBe(5175);
  });
});

describe('getWorktreeLabel', () => {
  it('returns null for the main worktree (no numeric suffix)', () => {
    expect(getWorktreeLabel('/Users/deanoemcke/Projects/sifty-webapp')).toBeNull();
  });

  it('returns the directory basename for a numbered worktree', () => {
    expect(
      getWorktreeLabel('/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp1')
    ).toBe('sifty-webapp1');
    expect(
      getWorktreeLabel('/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp3')
    ).toBe('sifty-webapp3');
  });

  it('ignores trailing slashes in the path', () => {
    expect(
      getWorktreeLabel('/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp2/')
    ).toBe('sifty-webapp2');
  });
});
