/**
 * [INPUT]: 编译后的目录锁、独立 Node 子进程与隔离目录。
 * [OUTPUT]: 崩溃恢复、旧锁迁移、活锁保护与多进程互斥回归。
 * [POS]: 锁协议的并发验收，避免恢复进程删除新所有者标记。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, mkdir, writeFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const modulePath = require.resolve('../dist/utils/operation-lock.js');
const { withDirectoryLock } = require(modulePath);

const fixture = async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'svb-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, lock: path.join(root, 'operation.lock') };
};
const exitedPid = () => {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  assert.equal(child.status, 0);
  return Number(child.stdout.toString());
};

test('recovers legacy dead PID locks without user deletion', async t => {
  const { lock } = await fixture(t);
  await mkdir(lock);
  await writeFile(path.join(lock, 'pid'), String(exitedPid()));
  assert.equal(await withDirectoryLock(lock, async () => 'recovered'), 'recovered');
  await assert.rejects(readdir(lock), { code: 'ENOENT' });
});

test('recovers a real crashed owner and releases the replacement on failure', async t => {
  const { lock } = await fixture(t);
  const child = spawn(process.execPath, ['-e', `
    const {withDirectoryLock}=require(${JSON.stringify(modulePath)});
    withDirectoryLock(process.argv[1],async()=>{process.send('locked');await new Promise(()=>{});});
  `, lock], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  await once(child, 'message');
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  await assert.rejects(withDirectoryLock(lock, async () => { throw new Error('task failure'); }), /task failure/);
  assert.equal(await withDirectoryLock(lock, async () => 'released'), 'released');
});

test('keeps live legacy owners, empty locks and damaged records intact', async t => {
  const { lock } = await fixture(t);
  await mkdir(lock);
  await assert.rejects(withDirectoryLock(lock, async () => assert.fail('entered empty lock')), /已有同步/);
  await writeFile(path.join(lock, 'pid'), String(process.pid));
  await assert.rejects(withDirectoryLock(lock, async () => assert.fail('entered live lock')), /已有同步/);
  assert.deepEqual(await readdir(lock), ['pid']);
  await writeFile(path.join(lock, 'pid'), 'incomplete');
  await assert.rejects(withDirectoryLock(lock, async () => assert.fail('entered damaged lock')), /已有同步/);
  assert.deepEqual(await readdir(lock), ['pid']);
});

test('competing recovery processes never enter a protected task together', { timeout: 30000 }, async t => {
  const { root, lock } = await fixture(t);
  const deadPid = exitedPid();
  let successes = 0;
  for (let round = 0; round < 6; round += 1) {
    await mkdir(lock);
    await writeFile(path.join(lock, round % 2 ? 'owner-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : 'pid'), String(deadPid));
    const workers = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ['-e', `
        const {withDirectoryLock}=require(${JSON.stringify(modulePath)});
        const {open,unlink}=require('node:fs/promises');
        const {setTimeout:delay}=require('node:timers/promises');
        process.once('message',async()=>{
          try {
            await withDirectoryLock(process.argv[1],async()=>{
              const guard=await open(process.argv[2],'wx');
              await delay(40); await guard.close(); await unlink(process.argv[2]);
            });
            process.exit(0);
          } catch(e) { if(!/已有同步/.test(e.message))process.stderr.write(e.stack||String(e));process.exit(/已有同步/.test(e.message)?2:1); }
        });
        process.send('ready');
      `, lock, path.join(root, 'critical-section')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      t.after(() => child.kill());
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      return { child, ready: once(child, 'message'), exit: once(child, 'exit'), errors: () => stderr };
    });
    await Promise.all(workers.map(worker => worker.ready));
    for (const { child } of workers) child.send('start');
    const codes = (await Promise.all(workers.map(worker => worker.exit))).map(([status]) => status);
    assert.ok(codes.every(status => status === 0 || status === 2), `unsafe recovery in round ${round}: ${codes}\n${workers.map(worker => worker.errors()).join('\n')}`);
    successes += codes.filter(status => status === 0).length;
    assert.equal(await withDirectoryLock(lock, async () => 'next'), 'next');
  }
  assert.ok(successes > 0, 'at least one competing process must execute the guarded task');
});
