import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {configDefaults} from 'vitest/config';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    test: {
      // Without this, vitest's default glob also picks up every *.test.ts checked out
      // into a Claude Code worktree (.claude/worktrees/<name>/tests/...) — a real, live
      // copy of this same suite running concurrently against the SAME shared dev
      // server/Postgres database as the main run. Two copies of e.g. zatcaWorkflow's hash
      // chain tests racing the same real chain state produces nondeterministic ICV/status
      // mismatches that have nothing to do with an actual regression (confirmed by
      // running the same file in isolation and seeing it pass cleanly).
      exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
    },
  };
});
