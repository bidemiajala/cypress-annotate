/**
 * Runs Cypress with ELECTRON_RUN_AS_NODE removed.
 *
 * VS Code's extension host — and anything else hosting a Node process inside
 * Electron — sets that variable. Cypress's own binary is Electron, so it then
 * starts as plain Node, rejects Chromium flags like --no-sandbox, and fails
 * with a misleading "Cypress failed to start / bad option" message.
 */
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync('npx', ['cypress', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
