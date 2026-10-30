import { randomInt } from 'node:crypto';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { createConnection, isIP, type Socket } from 'node:net';
import { checkServerIdentity, connect as connectTls } from 'node:tls';

export type ProbeStage = 'gateway' | 'authentication' | 'outbound' | 'tls' | 'http' | 'udp_relay' | 'udp_outbound' | 'dns' | 'complete' | 'skipped';
export type NodeProbePart = {
  success: boolean;
  stage: ProbeStage;
  detail: string;
  latencyMs: number;
  target: string;
  skipped?: true;
};
export type NodeProbeResult = { testedAt: string; tcp: NodeProbePart; udp: NodeProbePart };
export type NodeProbeOptions = { port: number; udpEnabled: boolean; tcpTarget?: string; udpTarget?: string; timeoutMs?: number };

const failureDetails: Record<ProbeStage, string> = {
  gateway: '无法连接本机节点入口，或连接超时。',
  authentication: '本机入口未接受 SOCKS5 无认证握手。',
  outbound: 'SOCKS5 出站连接失败或超时。',
  tls: '目标 TLS 握手或证书验证失败。',
  http: '未收到成功的 HTTP 响应。',
  udp_relay: '无法建立本机 SOCKS5 UDP 转发。',
  udp_outbound: 'UDP 转发未收到响应。',
  dns: 'UDP 返回的 DNS 响应无效或不匹配。',
  complete: '',
  skipped: 'UDP 转发未开启，未执行测试。',
};

// Read in paused mode so fragmented replies and bytes received between stages remain buffered.
const readExactly = (socket: Socket, size: number): Promise<Buffer> => new Promise((resolve, reject) => {
  const cleanup = () => {
    socket.off('readable', attempt);
    socket.off('error', failed);
    socket.off('end', ended);
    socket.off('close', ended);
  };
  const failed = () => { cleanup(); reject(new Error('Socket read failed')); };
  const ended = () => { cleanup(); reject(new Error('Socket closed')); };
  const attempt = () => {
    const bytes = socket.read(size) as Buffer | null;
    if (bytes !== null) { cleanup(); resolve(bytes); }
    else if (socket.destroyed || socket.readableEnded) ended();
  };
  socket.on('readable', attempt);
  socket.on('error', failed);
  socket.on('end', ended);
  socket.on('close', ended);
  attempt();
});

const connected = (socket: Socket, event = 'connect') => new Promise<void>((resolve, reject) => {
  const cleanup = () => { socket.off(event, ready); socket.off('error', failed); socket.off('close', failed); };
  const ready = () => { cleanup(); resolve(); };
  const failed = () => { cleanup(); reject(new Error('Connection failed')); };
  socket.once(event, ready);
  socket.once('error', failed);
  socket.once('close', failed);
});

const addressBytes = (host: string, port: number) => {
  const address = Buffer.from(host, 'utf8');
  if (!address.length || address.length > 255) throw new Error('Invalid target hostname');
  const result = Buffer.alloc(address.length + 4);
  result[0] = 3;
  result[1] = address.length;
  address.copy(result, 2);
  result.writeUInt16BE(port, result.length - 2);
  return result;
};

const socksReply = async (socket: Socket) => {
  const header = await readExactly(socket, 4);
  if (header[0] !== 5 || header[1] !== 0 || header[2] !== 0) throw new Error('SOCKS request rejected');
  let host: string;
  if (header[3] === 1) host = [...await readExactly(socket, 4)].join('.');
  else if (header[3] === 3) host = (await readExactly(socket, (await readExactly(socket, 1))[0]!)).toString('utf8');
  else if (header[3] === 4) {
    const address = await readExactly(socket, 16);
    host = Array.from({ length: 8 }, (_, index) => address.readUInt16BE(index * 2).toString(16)).join(':');
  } else throw new Error('Invalid SOCKS address');
  const port = (await readExactly(socket, 2)).readUInt16BE(0);
  return { host, port };
};

const runProbe = async (
  port: number,
  target: string,
  timeout: number,
  run: (socket: Socket, stage: (stage: ProbeStage) => void, track: (socket: Socket | DatagramSocket) => void) => Promise<string>,
): Promise<NodeProbePart> => {
  const started = Date.now();
  let stage: ProbeStage = 'gateway';
  const resources: Array<Socket | DatagramSocket> = [];
  const track = (socket: Socket | DatagramSocket) => { socket.on('error', () => undefined); resources.push(socket); };
  const cleanup = () => resources.forEach((socket) => {
    if ('destroy' in socket) socket.destroy();
    else { try { socket.close(); } catch { /* An unbound UDP socket has nothing to close. */ } }
  });
  const timer = setTimeout(cleanup, timeout);
  try {
    const socket = createConnection({ host: '127.0.0.1', port });
    track(socket);
    await connected(socket);
    stage = 'authentication';
    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await readExactly(socket, 2);
    if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error('Unsupported authentication');
    const detail = await run(socket, (next) => { stage = next; }, track);
    return { success: true, stage: 'complete', detail, target, latencyMs: Date.now() - started };
  } catch {
    return { success: false, stage, detail: failureDetails[stage], target, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    cleanup();
  }
};

const tcpProbe = (port: number, target: URL, timeout: number) => runProbe(port, target.href, timeout, async (socket, stage, track) => {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  stage('outbound');
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addressBytes(host, Number(target.port || (target.protocol === 'https:' ? 443 : 80)))]));
  await socksReply(socket);
  let stream = socket;
  if (target.protocol === 'https:') {
    stage('tls');
    stream = connectTls({ socket, servername: isIP(host) ? undefined : host, checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate), rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    track(stream);
    await connected(stream, 'secureConnect');
  }
  stage('http');
  stream.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\nUser-Agent: Surge-VLESS-Bridge-Diagnostic\r\n\r\n`);
  let headers = '';
  while (!headers.endsWith('\r\n\r\n') && headers.length < 16_384) headers += (await readExactly(stream, 1)).toString('latin1');
  const status = /^HTTP\/1\.[01] (\d{3})(?: |\r\n)/.exec(headers);
  if (!headers.endsWith('\r\n\r\n') || !status || Number(status[1]) < 200 || Number(status[1]) >= 400) throw new Error('Unexpected HTTP response');
  return `SOCKS5 出站${target.protocol === 'https:' ? '、TLS' : ''}和 HTTP 响应正常（${status[1]}）。`;
});

const dnsQuestion = (hostname: string) => Buffer.concat([
  ...hostname.split('.').map((label) => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])),
  Buffer.from([0, 0, 1, 0, 1]),
]);

const udpProbe = (port: number, target: string, hostname: string, resolver: string, timeout: number) => runProbe(port, target, timeout, async (socket, stage, track) => {
  stage('udp_relay');
  socket.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
  const relay = await socksReply(socket);
  // The owned Mihomo listener is local; do not follow an arbitrary relay advertised by another service.
  if (!['0.0.0.0', '127.0.0.1'].includes(relay.host) || !relay.port) throw new Error('Nonlocal relay');
  const udp = createSocket('udp4');
  track(udp);
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.once('close', () => reject(new Error('UDP socket closed')));
    udp.connect(relay.port, '127.0.0.1', resolve);
  });
  const id = randomInt(65536);
  const question = dnsQuestion(hostname);
  const dns = Buffer.alloc(12);
  dns.writeUInt16BE(id, 0);
  dns.writeUInt16BE(0x0100, 2);
  dns.writeUInt16BE(1, 4);
  const address = Buffer.from([0, 0, 0, 1, ...resolver.split('.').map(Number), 0, 53]);
  stage('udp_outbound');
  const response = await new Promise<Buffer>((resolve, reject) => {
    udp.once('message', resolve);
    udp.once('error', reject);
    udp.once('close', () => reject(new Error('UDP socket closed')));
    socket.once('close', () => reject(new Error('UDP association closed')));
    udp.send(Buffer.concat([address, dns, question]), (error) => { if (error) reject(error); });
  });
  stage('dns');
  if (response.length < address.length + 12 || !response.subarray(0, address.length).equals(address)) throw new Error('Invalid UDP frame');
  const payload = response.subarray(address.length);
  const flags = payload.readUInt16BE(2);
  if (payload.readUInt16BE(0) !== id || (flags & 0xf800) !== 0x8000 || (flags & 0x0200) !== 0 || ![0, 3].includes(flags & 15)
    || payload.readUInt16BE(4) !== 1 || !payload.subarray(12, 12 + question.length).equals(question)) throw new Error('Invalid DNS response');
  return 'SOCKS5 UDP 转发和 DNS 响应正常。';
});

export const diagnoseMihomoNode = async (options: NodeProbeOptions): Promise<NodeProbeResult> => {
  const { port, udpEnabled, tcpTarget = 'https://www.gstatic.com/generate_204', udpTarget = 'example.com@8.8.8.8', timeoutMs = 8_000 } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) throw new Error('诊断端口或超时无效。');
  let target: URL;
  try { target = new URL(tcpTarget); } catch { throw new Error('TCP 测试目标必须是 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error('TCP 测试目标格式无效。');
  const [hostname, resolver, extra] = udpTarget.split('@');
  if (udpEnabled && (!hostname || hostname.length > 253 || !hostname.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    || !resolver || isIP(resolver) !== 4 || extra !== undefined)) throw new Error('UDP 测试目标应为域名@IPv4。');
  const testedAt = new Date().toISOString();
  const [tcp, udp] = await Promise.all([
    tcpProbe(port, target, timeoutMs),
    udpEnabled ? udpProbe(port, udpTarget, hostname!, resolver!, timeoutMs) : Promise.resolve<NodeProbePart>({ success: false, skipped: true, stage: 'skipped', detail: failureDetails.skipped, latencyMs: 0, target: udpTarget }),
  ]);
  return { testedAt, tcp, udp };
};
