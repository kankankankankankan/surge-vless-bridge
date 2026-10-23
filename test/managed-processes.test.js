const assert = require('node:assert/strict');
const { mkdtemp, mkdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  findManagedSingBoxProcesses,
  parseProcessList,
  stopManagedSingBoxProcesses,
} = require('../dist/utils/managed-processes.js');

const waitForExit = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
  });

test('parses ps output and selects only the configured binary and managed config directory', () => {
  const output = [
    '  101 /opt/homebrew/bin/sing-box run -c /Users/demo/nodes/sing-box[2081].json',
    '  102 /opt/homebrew/bin/sing-box run -c /Users/demo/other/sing-box[2081].json',
    '  103 /usr/local/bin/sing-box run -c /Users/demo/nodes/sing-box[2082].json',
    '  bad row',
  ].join('\n');

  assert.deepEqual(parseProcessList(output).map((entry) => entry.pid), [101, 102, 103]);
  assert.deepEqual(
    findManagedSingBoxProcesses({
      output,
      singBoxBinary: '/opt/homebrew/bin/sing-box',
      outputDir: '/Users/demo/nodes',
      currentPid: 999,
    }).map((entry) => entry.pid),
    [101],
  );
});

test('stops a managed process and leaves an unrelated process running', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svb-managed-process-'));
  const outputDir = path.join(root, 'nodes with spaces');
  await mkdir(outputDir, { recursive: true });
  const managedConfig = path.join(outputDir, 'sing-box[2081].json');
  const unrelatedConfig = path.join(root, 'sing-box[2082].json');
  const script = 'setInterval(() => {}, 1000)';
  const managed = spawn(process.execPath, ['-e', script, managedConfig], { stdio: 'ignore' });
  const unrelated = spawn(process.execPath, ['-e', script, unrelatedConfig], { stdio: 'ignore' });

  t.after(() => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      unrelated.kill('SIGTERM');
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = await stopManagedSingBoxProcesses({ singBoxBinary: process.execPath, outputDir });
  await waitForExit(managed);

  assert.deepEqual(stopped.map((entry) => entry.pid), [managed.pid]);
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
});
