/**
 * [INPUT]: Native diagnostic adapter and isolated CLI executable fixtures.
 * [OUTPUT]: HTTP/UDP independence, legacy fallback and credential-safe failure checks.
 * [POS]: Exercises native diagnostics without probing user policies.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { diagnoseNativeNode } = require('../dist/desktop/native-probe.js');

const fixture = async (t, udpCode, httpCode = 'console.log(JSON.stringify({status:204,"duration-ms":12.6}))') => {
  const root = await mkdtemp(join(tmpdir(), 'svb-native-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'surge-cli');
  await writeFile(cli, `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[1]==='test-policy-udp'){${udpCode}}else{${httpCode}}\n`, { mode: 0o700 });
  return { cli, cwd: root, policy: 'Fixture Policy', timeoutMs: 3000 };
};

test('native HTTP and UDP use separate probes and round fractional milliseconds', async t => {
  const options = await fixture(t, 'console.log(JSON.stringify({[args[2]]:{receive:20.7}}))');
  const result = await diagnoseNativeNode(options);
  assert.equal(result.tcp.success, true);
  assert.equal(result.tcp.latencyMs, 13);
  assert.equal(result.udp.success, true);
  assert.equal(result.udp.latencyMs, 21);
});

test('legacy UDP command stays untested while HTTP succeeds', async t => {
  for (const response of ['console.error("Unknown command: test-policy-udp");process.exit(1)',
    'console.log(JSON.stringify({error:"Unknown command"}))', 'console.log("Unknown command")']) {
    const options = await fixture(t, response);
    const result = await diagnoseNativeNode(options);
    assert.equal(result.tcp.success, true);
    assert.equal(result.udp.skipped, true);
    assert.match(result.udp.detail, /更新 Surge/);
  }
});

test('UDP errors and missing policy responses never become successful or expose raw output', async t => {
  for (const output of [{}, { 'Fixture Policy': { receive: -1 } }, { 'Fixture Policy': { receive: '42' } },
    { Other: { receive: 1 } }, { 'Fixture Policy': { error: 'password=PRIVATE_FIXTURE' } }]) {
    const options = await fixture(t, `console.log(${JSON.stringify(JSON.stringify(output))})`);
    const result = await diagnoseNativeNode(options);
    assert.equal(result.udp.success, false);
    assert.notEqual(result.udp.skipped, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE/);
  }
});

test('HTTP failure does not suppress a valid UDP response or leak CLI errors', async t => {
  const options = await fixture(t, 'console.log(JSON.stringify({[args[2]]:{receive:0}}))',
    'console.error("password=PRIVATE_FIXTURE");process.exit(1)');
  const result = await diagnoseNativeNode(options);
  assert.equal(result.tcp.success, false);
  assert.equal(result.udp.success, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE/);
});

test('native probes bound hung subprocesses', async t => {
  const options = await fixture(t, 'setInterval(()=>{},1000)', 'setInterval(()=>{},1000)');
  const result = await diagnoseNativeNode({ ...options, timeoutMs: 150 });
  assert.equal(result.tcp.success, false);
  assert.equal(result.udp.success, false);
  assert.match(result.udp.detail, /超时/);
});
