/**
 * [INPUT]: A packaged application and isolated synthetic subscriptions.
 * [OUTPUT]: Runtime dependency, External sync and native multi-protocol scheduler checks.
 * [POS]: Packaged Electron acceptance; all profiles and history stay in temporary storage.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.argv[2]) throw new Error('Usage: npm run desktop:smoke -- "/path/to/Surge VLESS Bridge.app"');
const root = await mkdtemp(join(tmpdir(), 'surge-vless-desktop-smoke-'));
const appRoot = join(resolve(process.argv[2]), 'Contents');
const executablePath = join(appRoot, 'MacOS', 'Surge VLESS Bridge');
const scheduledEntryPath = join(
  appRoot,
  'Resources',
  'app.asar.unpacked',
  'dist',
  'desktop',
  'scheduled-run.js',
);
const undiciPath = join(appRoot, 'Resources', 'app.asar.unpacked', 'node_modules', 'undici', 'index.js');
const profilePath = join(root, 'profile.conf');
const configPath = join(root, 'config.json');

try {
  const undiciStat = await stat(undiciPath).catch(() => undefined);
  if (!undiciStat?.isFile()) throw new Error('Packaged app is missing the undici runtime dependency.');
  await writeFile(
    profilePath,
    ['[Proxy]', 'DIRECT = direct', '', '[Proxy Group]', 'Proxy = select, DIRECT', '', '[Rule]', 'FINAL,Proxy', ''].join(
      '\n',
    ),
    'utf8',
  );
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        runtimeMode: 'external',
        runtimeModeConfirmed: true,
        subscriptionUrls: [`data:application/json;base64,${Buffer.from(JSON.stringify({ proxies: [{
          name: 'Scheduled Smoke', type: 'vless', server: 'example.com', port: 443,
          uuid: '00000000-0000-4000-8000-000000000001', tls: true, network: 'ws',
          'ws-opts': { path: '/smoke', headers: { Host: 'cdn.example.com' } },
        }] })).toString('base64')}`],
        vlessNodes: [],
        surgeConfigPath: profilePath,
        singBoxBinary: '/usr/bin/true',
        outputDir: join(root, 'nodes'),
        backupDir: join(root, 'backups'),
        subscriptionOutputPath: join(root, 'vless_nodes.txt'),
        autoReload: false,
        udpRelay: true,
        addressResolver: 'off',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = spawnSync(executablePath, [scheduledEntryPath, '--config', configPath], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Packaged scheduler exited with ${result.status}`);
  }

  const profile = await readFile(profilePath, 'utf8');
  const history = JSON.parse(await readFile(join(root, 'desktop', 'history.json'), 'utf8'));
  if (!profile.includes('Scheduled Smoke = external')) {
    throw new Error('Packaged scheduler did not update the temporary Surge profile.');
  }
  if (!profile.includes('udp-relay=true')) {
    throw new Error('Packaged scheduler did not preserve the UDP relay setting.');
  }
  const manifest = JSON.parse(await readFile(join(root, 'nodes', 'manifest.json'), 'utf8'));
  if (manifest.files.length !== 1 || !/^sing-box\[\d+\]\.json$/.test(manifest.files[0])) throw new Error('Unexpected packaged node manifest.');
  const node = JSON.parse(await readFile(join(root, 'nodes', manifest.files[0]), 'utf8')).outbounds[0];
  if (node.transport?.path !== '/smoke' || node.transport?.headers?.Host !== 'cdn.example.com') {
    throw new Error('Packaged subscription parser did not preserve the Clash WS options.');
  }
  if (history[0]?.action !== 'scheduled-sync' || history[0]?.success !== true) {
    throw new Error('Packaged scheduler did not write a successful history entry.');
  }

  const nativeConfig = JSON.parse(await readFile(configPath, 'utf8'));
  nativeConfig.runtimeMode = 'surge-native';
  nativeConfig.anytlsSniOverrides = [{ server: 'anytls.example', port: 443, sni: 'saved-cert.example',
    certificateVerifyName: 'verify.example', reuse: false }];
  nativeConfig.subscriptionUrls = [`data:text/plain,${encodeURIComponent(Buffer.from([
    'vless://00000000-0000-4000-8000-000000000001@example.com:443?encryption=none#NativeVLESS',
    'anytls://synthetic-secret@anytls.example:443?sni=tls.example#NativeAnyTLS',
    'hy2://synthetic-secret@hy2.example:443?sni=tls.example#NativeHY2',
    `ss://${Buffer.from('aes-128-gcm:synthetic-secret').toString('base64url')}@ss.example:443#NativeSS`,
    `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'NativeVMess', add: 'vmess.example', port: 443,
      id: '00000000-0000-4000-8000-000000000001', aid: 0, scy: 'auto', tls: 'tls' })).toString('base64url')}`,
  ].join('\n')).toString('base64'))}`];
  await writeFile(configPath, JSON.stringify(nativeConfig), 'utf8');
  const nativeResult = spawnSync(executablePath, [scheduledEntryPath, '--config', configPath], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (nativeResult.status !== 0) throw new Error(nativeResult.stderr || nativeResult.stdout || 'Packaged native scheduler failed.');
  const nativeProfile = await readFile(profilePath, 'utf8');
  const anytlsLine = nativeProfile.split('\n').find(line => line.startsWith('NativeAnyTLS = anytls,'));
  if (!anytlsLine?.includes('sni=saved-cert.example') || !anytlsLine.includes('server-cert-verify-name=verify.example')
    || !anytlsLine.includes('reuse=false') || anytlsLine.includes('skip-cert-verify=true')) {
    throw new Error('Packaged scheduler did not preserve AnyTLS TLS names, reuse and strict certificate verification.');
  }
  for (const [name, type] of [['NativeVLESS', 'vless'], ['NativeAnyTLS', 'anytls'], ['NativeHY2', 'hysteria2'], ['NativeSS', 'ss'], ['NativeVMess', 'vmess']]) {
    if (!nativeProfile.includes(`${name} = ${type},`)) throw new Error(`Packaged native conversion missing ${type}.`);
  }
  const nativeHistory = JSON.parse(await readFile(join(root, 'desktop', 'history.json'), 'utf8'));
  if (nativeHistory[0]?.count !== 5 || nativeHistory[0]?.success !== true) throw new Error('Packaged native sync did not record all protocols.');

  console.log('Packaged scheduler smoke test passed: External and native multi-protocol.');
} finally {
  await rm(root, { recursive: true, force: true });
}
