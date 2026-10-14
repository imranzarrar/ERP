// PM2 process definition for the 2.0 DEMO app on the same VPS as live. Separate name (erp-demo) so every PM2 command in the live
// scripts (they all target deploy/ecosystem.config.cjs, i.e. the app named "erp") can never see, reload or stop this one, and the
// other way round. One fork instance is plenty for a demo. Port and bind address come from the demo's own app.secrets
// (PORT=4000, HOST=127.0.0.1), which server.ts loads itself.
module.exports = {
  apps: [
    {
      name: 'erp-demo',
      script: './dist/server.cjs',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '15s',
      max_memory_restart: '500M',
      out_file: './deploy/logs/erp-demo-out.log',
      error_file: './deploy/logs/erp-demo-error.log',
      time: true,
      merge_logs: true,
    },
  ],
};
