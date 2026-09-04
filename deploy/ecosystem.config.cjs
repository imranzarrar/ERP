// PM2 process definition for the production VPS. Lives in the repo so it's version-
// controlled and pulled by every deploy — never edited by hand on the server.
//
// Cluster mode with 2 instances gives PM2's built-in round-robin load balancing across the
// VPS's 2 vCPUs and lets `pm2 reload` restart one instance at a time (zero-downtime deploy)
// instead of `pm2 restart`, which kills and respawns everything at once.
module.exports = {
  apps: [
    {
      name: 'erp',
      script: './dist/server.cjs',
      cwd: __dirname + '/..',
      instances: 2,
      exec_mode: 'cluster',
      // Matches CLAUDE.md's Secrets section: server.ts loads app.secrets itself via
      // dotenv.config({ path: 'app.secrets' }) — PM2 doesn't need to inject env vars here,
      // it just needs NODE_ENV so Express/Vite-built assets behave in production mode.
      env: {
        NODE_ENV: 'production',
      },
      // Restart on crash, but stop retrying if it crashes immediately in a loop (bad
      // deploy) rather than hammering Postgres/disk with a restart storm.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '15s',
      // Restart an instance if it leaks past this — a safety net, not a substitute for
      // fixing an actual leak.
      max_memory_restart: '600M',
      // Logs — rotate these yourself later (pm2-logrotate module) once volume justifies it.
      out_file: './deploy/logs/erp-out.log',
      error_file: './deploy/logs/erp-error.log',
      time: true,
      merge_logs: true,
    },
  ],
};
