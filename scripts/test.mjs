import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const files = readdirSync('server/tests')
  .filter((name) => /\.test\.(mjs|ts)$/.test(name))
  .sort()
  .map((name) => `server/tests/${name}`);

// Fixture subprocesses also need TypeScript transforms, including parameter properties.
const nodeOptions = [process.env.NODE_OPTIONS, '--experimental-transform-types']
  .filter(Boolean)
  .join(' ');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
