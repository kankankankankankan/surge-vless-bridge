/**
 * [INPUT]: Surge CLI path and a policy verified against the managed profile.
 * [OUTPUT]: Independent HTTP and UDP probe results with integer millisecond timing.
 * [POS]: Native diagnostic adapter; leaves routing and profile content unchanged.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NodeProbePart, NodeProbeResult } from '../mihomo/probe';

const execFileAsync = promisify(execFile);
const httpTarget = 'https://www.gstatic.com/generate_204';
const integerLatency = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;

export const diagnoseNativeNode = async ({ cli, policy, cwd, timeoutMs = 15_000 }: {
  cli: string; policy: string; cwd: string; timeoutMs?: number;
}): Promise<NodeProbeResult> => {
  const testedAt = new Date().toISOString();
  const run = async (protocol: 'tcp' | 'udp'): Promise<NodeProbePart> => {
    const started = Date.now();
    const target = protocol === 'tcp' ? httpTarget : 'Surge UDP 策略测试';
    let cliOutput = '';
    try {
      const args = protocol === 'tcp' ? ['--raw', 'http', 'probe', httpTarget, policy]
        : ['--raw', 'test-policy-udp', policy];
      const { stdout } = await execFileAsync(cli, args, { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 });
      cliOutput = stdout;
      const result = JSON.parse(stdout);
      if (protocol === 'udp' && typeof result?.error === 'string' && /unknown command|unrecognized command|unsupported command/i.test(result.error)) {
        throw new Error('Unavailable UDP command');
      }
      if (protocol === 'tcp') {
        const status = result?.status;
        const latencyMs = integerLatency(result?.['duration-ms'], Date.now() - started);
        const success = typeof status === 'number' && status >= 200 && status < 400;
        return { success, stage: 'http', detail: `HTTP ${typeof status === 'number' ? status : '无有效响应'} · ${latencyMs} ms`, latencyMs, target };
      }
      const received = Object.hasOwn(result ?? {}, policy) ? result[policy]?.receive : undefined;
      if (typeof received === 'number' && Number.isFinite(received) && received >= 0) {
        return { success: true, stage: 'complete', detail: 'Surge UDP 策略测试收到响应。', latencyMs: Math.round(received), target };
      }
      return { success: false, stage: 'udp_outbound', detail: 'Surge UDP 测试未返回有效响应；请检查节点 UDP 支持和 Surge 测试结果。', latencyMs: Date.now() - started, target };
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string; killed?: boolean };
      // CLI errors can contain policy configuration. Only use known codes to classify them.
      const output = `${failure.stderr ?? ''}\n${failure.stdout ?? cliOutput}`;
      if (protocol === 'udp' && /unknown command|unrecognized command|unsupported command/i.test(output)) {
        return { success: false, skipped: true, stage: 'skipped', detail: '当前 Surge 不支持 UDP 测试命令，请更新 Surge。', latencyMs: 0, target: '-' };
      }
      return { success: false, stage: protocol === 'tcp' ? 'http' : 'udp_outbound',
        detail: failure.killed ? '策略测试超时。' : '策略测试失败，请在 Surge 中查看节点测试结果。',
        latencyMs: Date.now() - started, target };
    }
  };
  const [tcp, udp] = await Promise.all([run('tcp'), run('udp')]);
  return { testedAt, tcp, udp };
};
