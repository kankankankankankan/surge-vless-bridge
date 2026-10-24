const assert = require('node:assert/strict');
const test = require('node:test');

const { downloadResponseBuffer, runStreamingCommand } = require('../dist/install-progress.js');

test('download progress reports streamed bytes and preserves the response body', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from('defg')];
  const response = new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  }), { headers: { 'content-length': '7' } });
  const progress = [];

  const result = await downloadResponseBuffer({
    response,
    expectedSize: 7,
    onProgress: (receivedBytes, totalBytes) => progress.push([receivedBytes, totalBytes]),
  });

  assert.equal(result.toString(), 'abcdefg');
  assert.deepEqual(progress, [[3, 7], [7, 7]]);
});

test('streaming commands expose stdout and stderr lines before completion', async () => {
  const lines = [];
  const result = await runStreamingCommand({
    file: process.execPath,
    args: ['-e', "console.log('download'); console.error('install')"],
    timeout: 10_000,
    onLine: (line) => lines.push(line),
  });

  assert.deepEqual(lines, ['download', 'install']);
  assert.match(result.stdout, /download/);
  assert.match(result.stderr, /install/);
});
