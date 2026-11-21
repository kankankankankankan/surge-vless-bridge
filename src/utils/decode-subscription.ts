/**
 * [INPUT]: Raw HTTP subscription response text.
 * [OUTPUT]: URI list detection and plain or Base64-decoded link-list text.
 * [POS]: Shared link-list boundary used by the subscription parser and envelope decoder.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
export const parseProxyLinkList = (raw: string): string[] | undefined => {
  const entries = raw.split(/\r\n|\n|\r/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  // Protocol selection belongs to the caller. A new scheme must not invalidate
  // adjacent VLESS nodes. Keep unescaped spaces in display-name fragments intact.
  return entries.length && entries.every(line => /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S/.test(line))
    ? entries : undefined;
};

// Subscriptions come either as a plain list of proxy links or as that list in Base64. Decoding
// blindly turns a plain-text response into mojibake that silently yields zero nodes, so the format is
// detected first and anything unrecognised is reported instead of guessed at.
export const decodeSubscription = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Subscription response is empty.');
  }

  if (parseProxyLinkList(trimmed)) {
    return trimmed;
  }

  const compact = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('Subscription response is neither a proxy link list nor valid Base64.');
  }

  // Providers serve either standard Base64 or the URL-safe alphabet.
  const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
  if (!parseProxyLinkList(decoded)) {
    throw new Error('Decoded subscription does not contain any supported proxy links.');
  }

  return decoded;
};
