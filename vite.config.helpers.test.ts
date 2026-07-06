import { describe, expect, it } from "vitest";
import { getWorktreePort } from "./vite.config.helpers";

describe("getWorktreePort", () => {
  it("returns the base port for the main worktree (no numeric suffix)", () => {
    expect(getWorktreePort("/Users/deanoemcke/Projects/sifty-webapp")).toBe(5173);
  });

  it("returns base port + suffix for a numbered worktree", () => {
    expect(getWorktreePort("/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp1")).toBe(5174);
    expect(getWorktreePort("/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp3")).toBe(5176);
  });

  it("ignores trailing slashes in the path", () => {
    expect(getWorktreePort("/Users/deanoemcke/Projects/sifty-webapp.worktrees/sifty-webapp2/")).toBe(5175);
  });
});
