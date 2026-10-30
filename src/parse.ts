import { writeTextFile } from './utils/fs';
import { decodeSubscription } from './utils/decode-subscription';
import { parseClashVlessNodes } from './utils/parse-clash-vless';

const SUBSCRIPTION_TIMEOUT_MS = 15_000;

const extractVlessLinks = (value: string) =>
  [...value.matchAll(/vless:\/\/[^\s"'<>\\},]+/gi)].map((match) => match[0].replace(/[),.;]+$/, ''));

const decodeBase64Candidate = (value: string) => {
  const compact = value.trim().replace(/^\uFEFF/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length % 4 === 1) return '';
  return Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
};

// Subscription URLs carry a token, in the query string or in the path itself, so failures name the
// provider by origin only. Without this, a user with several subscriptions cannot tell which one
// returned the error.
const describeSubscriptionUrl = (subscriptionUrl: string) => {
  try {
    const url = new URL(subscriptionUrl);
    return url.protocol === 'data:' ? 'data: URL' : url.origin;
  } catch {
    return 'subscription URL';
  }
};

export const getVlessSubscriptionNodes = async ({
  subscriptionUrl,
  requestHeaders,
  subscriptionOutputPath,
}: {
  subscriptionUrl: string;
  requestHeaders?: Record<string, string>;
  subscriptionOutputPath?: string;
}) => {
  const source = describeSubscriptionUrl(subscriptionUrl);

  let response: Response;
  try {
    response = await fetch(subscriptionUrl, {
      headers: requestHeaders,
      // Without a deadline an unresponsive provider hangs `sync` indefinitely.
      signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Failed to fetch subscription ${source}: ${error instanceof Error ? error.message : error}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch subscription ${source}: ${response.status} ${response.statusText}`);
  }

  const rawData = await response.text();
  const candidates = [rawData];
  try {
    candidates.push(decodeSubscription(rawData));
  } catch {
    // Clash YAML/JSON is parsed below; the legacy decoder intentionally rejects those formats.
  }
  const base64Decoded = decodeBase64Candidate(rawData);
  if (base64Decoded && base64Decoded !== rawData.trim()) candidates.push(base64Decoded);

  const vlessNodes = [
    ...new Set(candidates.flatMap((candidate) => [...extractVlessLinks(candidate), ...parseClashVlessNodes(candidate)])),
  ];
  if (subscriptionOutputPath) {
    await writeTextFile(subscriptionOutputPath, `${vlessNodes.join('\n')}\n`);
  }

  return vlessNodes;
};
