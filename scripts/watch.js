// Dev watch daemon: rebuild + redeploy the SDK whenever src/ changes.
//
// Uses Node's built-in recursive fs.watch (no extra dependency). Debounced so a
// burst of editor saves triggers a single build. Also runs one build+deploy on
// startup so consumers immediately have current output. Ctrl-C to stop.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy } from './deploy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DEBOUNCE_MS = 450; // mirrors the server's SCRIPT_DEPLOY_DEBOUNCE_MS precedent

let timer = null;
let running = false;
let pendingWhileRunning = false;

function buildAndDeploy() {
  if (running) {
    pendingWhileRunning = true;
    return;
  }
  running = true;
  try {
    console.log('[sdk-watch] Building...');
    const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      console.error('[sdk-watch] Build failed — not deploying.');
      return;
    }
    deploy();
    console.log('[sdk-watch] Deployed. Watching for changes...');
  } catch (err) {
    console.error('[sdk-watch] Error:', err.message);
  } finally {
    running = false;
    if (pendingWhileRunning) {
      pendingWhileRunning = false;
      schedule();
    }
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(buildAndDeploy, DEBOUNCE_MS);
}

console.log(`[sdk-watch] Watching ${SRC}`);
buildAndDeploy();

fs.watch(SRC, { recursive: true }, (_event, filename) => {
  if (filename && filename.endsWith('.ts')) schedule();
});
