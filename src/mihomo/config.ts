import { stringify } from 'yaml';

import type { CliConfig } from '../types/cli-config';
import type { SingBoxVlessOutbound } from '../types/sing-box-vless-outbound';

export type MihomoNode = {
  name: string;
  port: number;
  server: string;
  proxy: Record<string, unknown>;
};

const transportOptions = (outbound: SingBoxVlessOutbound) => {
  const transport = outbound.transport;
  if (!transport) return {};

  if (transport.type === 'ws') {
    return {
      network: 'ws',
      'ws-opts': {
        path: transport.path ?? '/',
        ...(transport.headers ? { headers: transport.headers } : {}),
      },
    };
  }
  if (transport.type === 'grpc') {
    return {
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': transport.service_name ?? 'grpc' },
    };
  }
  if (transport.type === 'httpupgrade') {
    return {
      network: 'httpupgrade',
      'httpupgrade-opts': {
        path: transport.path ?? '/',
        host: transport.host ?? outbound.server,
      },
    };
  }
  return {};
};

export const mapVlessToMihomoProxy = (
  outbound: SingBoxVlessOutbound,
  name: string,
  config: Pick<CliConfig, 'udpRelay' | 'tcpFastOpen'>,
) => ({
  name,
  type: 'vless',
  server: outbound.server,
  port: outbound.server_port,
  uuid: outbound.uuid,
  udp: config.udpRelay,
  ...(config.tcpFastOpen ? { tfo: true } : {}),
  ...(outbound.flow ? { flow: outbound.flow } : {}),
  ...(outbound.packet_encoding ? { 'packet-encoding': outbound.packet_encoding } : {}),
  ...(outbound.tls?.enabled
    ? {
        tls: true,
        ...(outbound.tls.server_name ? { servername: outbound.tls.server_name } : {}),
        ...(outbound.tls.insecure ? { 'skip-cert-verify': true } : {}),
        ...(outbound.tls.utls?.fingerprint ? { 'client-fingerprint': outbound.tls.utls.fingerprint } : {}),
        ...(outbound.tls.reality?.public_key
          ? {
              'reality-opts': {
                'public-key': outbound.tls.reality.public_key,
                ...(outbound.tls.reality.short_id ? { 'short-id': outbound.tls.reality.short_id } : {}),
              },
            }
          : {}),
      }
    : {}),
  ...transportOptions(outbound),
});

export const buildMihomoDocument = ({ nodes, config }: { nodes: MihomoNode[]; config: CliConfig }) => ({
  mode: 'direct',
  'log-level': config.mihomo.logLevel,
  ipv6: true,
  'allow-lan': false,
  'external-controller': `${config.mihomo.controllerHost}:${config.mihomo.controllerPort}`,
  secret: config.mihomo.controllerSecret,
  proxies: nodes.map((node) => node.proxy),
  listeners: nodes.map((node) => ({
    name: `surge-vless-${node.port}`,
    type: 'socks',
    listen: '127.0.0.1',
    port: node.port,
    udp: config.udpRelay,
    proxy: node.name,
  })),
  rules: ['MATCH,DIRECT'],
});

export const renderMihomoConfig = (input: { nodes: MihomoNode[]; config: CliConfig }) =>
  stringify(buildMihomoDocument(input), { lineWidth: 0 });

export const buildMihomoSurgeProxyLine = ({
  name,
  port,
  config,
}: {
  name: string;
  port: number;
  config: Pick<CliConfig, 'udpRelay' | 'udpTestEnabled' | 'udpTestTarget' | 'tcpFastOpen'>;
}) => {
  const parameters = [`${name} = socks5`, '127.0.0.1', String(port)];
  if (config.udpRelay) parameters.push('udp-relay=true');
  if (config.udpRelay && config.udpTestEnabled) parameters.push(`test-udp=${config.udpTestTarget}`);
  if (config.tcpFastOpen) parameters.push('tfo=true');
  return parameters.join(', ');
};
