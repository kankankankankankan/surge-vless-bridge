import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  reportDoctorChecks,
  runCommonDoctorChecks,
  type DoctorCheck,
} from '../surge';
import type { CliConfig } from '../types/cli-config';
import { pathExists } from '../utils/fs';
import { getMihomoServiceStatus } from './launch-agent';
import { readMihomoNodes } from './sync';

const execFileAsync = promisify(execFile);

const probeTcpListener = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

export const runMihomoDoctor = async (config: CliConfig) => {
  const checks = await runCommonDoctorChecks(config);
  const binaryExists = Boolean(config.mihomo.binary) && (await pathExists(config.mihomo.binary));
  const dataDirExists = await pathExists(config.mihomo.dataDir);
  const configPath = join(config.mihomo.dataDir, 'config.yaml');
  const configExists = await pathExists(configPath);

  checks.splice(2, 0, {
    label: 'mihomoBinary',
    level: binaryExists ? 'ok' : 'fail',
    detail: config.mihomo.binary || 'missing',
  });
  checks.splice(3, 0, {
    label: 'mihomo-data-dir',
    level: dataDirExists ? 'ok' : 'warn',
    detail: dataDirExists ? config.mihomo.dataDir : `${config.mihomo.dataDir} (not created yet; run \`sync\`)`,
  });

  let configLevel: DoctorCheck['level'] = configExists ? 'ok' : 'warn';
  let configDetail = configExists ? 'config.yaml found' : 'config.yaml not created yet; run `sync`';
  if (configExists && binaryExists) {
    try {
      await execFileAsync(config.mihomo.binary, ['-t', '-f', configPath], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      configDetail = 'config.yaml passed `mihomo -t`';
    } catch {
      configLevel = 'fail';
      configDetail = 'config.yaml was rejected by `mihomo -t`';
    }
  }
  checks.splice(4, 0, { label: 'mihomo-config', level: configLevel, detail: configDetail });

  const service = await getMihomoServiceStatus(config);
  const expectedLevel: DoctorCheck['level'] = configExists ? 'fail' : 'warn';
  checks.push({
    label: 'mihomo-launch-agent',
    level: service.installed && service.loaded ? 'ok' : expectedLevel,
    detail: service.installed
      ? service.loaded
        ? `loaded${service.pid ? `, pid ${service.pid}` : ''}`
        : 'installed but not loaded'
      : 'not installed',
  });
  checks.push({
    label: 'mihomo-controller',
    level: service.controllerReady ? 'ok' : expectedLevel,
    detail: service.controllerReady
      ? `ready on ${config.mihomo.controllerHost}:${config.mihomo.controllerPort}`
      : `unreachable on ${config.mihomo.controllerHost}:${config.mihomo.controllerPort}`,
  });

  if (configExists) {
    const nodes = await readMihomoNodes(config).catch(() => []);
    const listenerResults = await Promise.all(nodes.map(async (node) => probeTcpListener(node.port)));
    const reachable = listenerResults.filter(Boolean).length;
    checks.push({
      label: 'mihomo-listeners',
      level: nodes.length > 0 && reachable === nodes.length ? 'ok' : 'fail',
      detail: `${reachable}/${nodes.length} loopback TCP listeners reachable`,
    });
  } else {
    checks.push({
      label: 'mihomo-listeners',
      level: 'warn',
      detail: 'not checked before the first sync',
    });
  }

  return reportDoctorChecks(checks);
};
