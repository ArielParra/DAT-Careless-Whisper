import { readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};

  const env = {};
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function run(command, args, env) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function getPidsListeningOnPort(port) {
  const targetPort = String(port);
  const result = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) {
    return [];
  }

  const lines = result.stdout.split(/\r?\n/).filter((line) => line.includes(`:${targetPort}`));
  const pids = new Set();

  for (const line of lines) {
    const matches = line.matchAll(/pid=(\d+)/g);
    for (const match of matches) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }
  }

  return [...pids];
}

function isPortInUse(port) {
  const targetPort = String(port);
  const result = spawnSync('ss', ['-ltn'], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) {
    return false;
  }

  return result.stdout.split(/\r?\n/).some((line) => line.includes(`:${targetPort}`));
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function waitUntilPortFree(port, timeoutMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isPortInUse(port)) {
      return true;
    }
    await sleep(150);
  }

  return !isPortInUse(port);
}

async function ensurePortIsFree(port) {
  if (!isPortInUse(port)) {
    return true;
  }

  const pids = getPidsListeningOnPort(port);
  if (pids.length === 0) {
    return false;
  }

  console.log(`[dev-runner] Port ${port} is in use by PID(s): ${pids.join(', ')}. Stopping previous process(es)...`);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be gone.
    }
  }

  const released = await waitUntilPortFree(port, 5000);
  if (released) {
    return true;
  }

  const remainingPids = getPidsListeningOnPort(port);
  if (remainingPids.length === 0) {
    return !isPortInUse(port);
  }

  console.log(`[dev-runner] Force-stopping PID(s) on port ${port}: ${remainingPids.join(', ')}`);
  for (const pid of remainingPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may already be gone.
    }
  }

  return await waitUntilPortFree(port, 2000);
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'server' && mode !== 'client') {
    console.error('Usage: node scripts/dev-runner.mjs <server|client>');
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const envFilePath = resolve(repoRoot, '.env');
  const fileEnv = parseEnvFile(envFilePath);
  const mergedEnv = { ...process.env, ...fileEnv };

  if (mode === 'server') {
    mergedEnv.PORT = mergedEnv.BACKEND_PORT || mergedEnv.PORT || '3001';
    const released = await ensurePortIsFree(mergedEnv.PORT);
    if (!released) {
      console.log(`[dev-runner] Port ${mergedEnv.PORT} is already in use. Assuming server is already running; skipping start.`);
      process.exit(0);
    }
    run('npm', ['run', 'start:server', '--prefix', 'backend'], mergedEnv);
    return;
  }

  mergedEnv.PORT = mergedEnv.CLIENT_PORT || mergedEnv.PORT || '3000';
  mergedEnv.REACT_APP_API_URL =
    mergedEnv.REACT_APP_API_URL ||
    mergedEnv.BACKEND_URL ||
    `http://localhost:${mergedEnv.BACKEND_PORT || '3001'}`;

  const released = await ensurePortIsFree(mergedEnv.PORT);
  if (!released) {
    console.log(`[dev-runner] Port ${mergedEnv.PORT} is already in use. Assuming client is already running; skipping start.`);
    process.exit(0);
  }
  run('npm', ['start', '--prefix', 'frontend'], mergedEnv);
}

main().catch((err) => {
  console.error('[dev-runner] Failed to start:', err);
  process.exit(1);
});
