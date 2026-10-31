import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'surge-vless-desktop-smoke-'));
const appOutputDir = process.env.SVB_PACKAGED_APP_DIR ?? 'mac-arm64';
if (!['mac-arm64', 'mac'].includes(appOutputDir)) {
  throw new Error(`Unsupported packaged app directory: ${appOutputDir}`);
}
const appRoot = join(process.cwd(), 'release', appOutputDir, 'Surge VLESS Bridge.app', 'Contents');
const executablePath = join(appRoot, 'MacOS', 'Surge VLESS Bridge');
const scheduledEntryPath = join(
  appRoot,
  'Resources',
  'app.asar.unpacked',
  'dist',
  'desktop',
  'scheduled-run.js',
);
const profilePath = join(root, 'profile.conf');
const configPath = join(root, 'config.json');

try {
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

  console.log('Packaged scheduler smoke test passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
