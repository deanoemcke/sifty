# Git Worktree Setup

This project uses git worktrees. Each worktree has its own `node_modules` — it is never shared or symlinked from the main working tree or another worktree.

**If `npm`/`vitest`/`tsc` fails with `Cannot find module` or `MODULE_NOT_FOUND`, first check for a local `node_modules`** (`test -d node_modules`). If it's missing, run `npm install` from this worktree's own root as the first fix — don't assume it's a real code bug, and don't symlink `node_modules` in from another worktree.

Each worktree's dev server (`npm run dev`) binds to a fixed, deterministic port derived from the worktree's directory name: `5173 + <trailing digit in the directory name>` (main `sifty-webapp` = 5173, `sifty-webapp1` = 5174, `sifty-webapp2` = 5175, `sifty-webapp3` = 5176, etc.). `vite.config.ts` sets `strictPort: true`, so if `npm run dev` fails to start, the port is genuinely already in use by *this same worktree's* prior server — check via `lsof -i :<port>` and either reuse it or kill it, rather than assuming a code bug. Never assume port 5173 is "the" dev server when working in a non-main worktree.

**Always run `vitest` and `tsc` from the worktree's own directory** — never `cd` to the parent project first. Running from the parent will silently test the parent's source files instead of the worktree's, giving false results.

---

# Formatting & Linting

Formatting and linting are enforced by [Biome](biome.json), not Prettier/ESLint. Run `npm run format` (write) or `npm run check` (verify) before committing — don't hand-tune whitespace, since any formatter run will collapse it back to Biome's rules.

---
