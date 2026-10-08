/**
 * fetch() for URLs a USER supplied (the "analyze this link" box, outbound webhooks).
 *
 * The server sits inside a private network, so a user-chosen URL must not be able to
 * reach localhost, a private range, or a cloud metadata address. Each hop is checked
 * before it is requested: the scheme must be http(s), and every address the host
 * resolves to must be public. Redirects are followed by hand so the same check runs on
 * each one, and the body is read with a size cap.
 *
 * Known limit: the name is resolved here and again by fetch(), so a DNS answer that
 * changes between the two is not caught. Closing that needs a pinned-address agent.
 */
const dns = require('dns').promises;
const net = require('net');

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 127],        // unspecified + loopback
  ['fc00::', 7],      // unique local
  ['fe80::', 10],     // link local
  ['ff00::', 8],      // multicast
]) blocked.addSubnet(addr, prefix, 'ipv6');

class UnsafeUrlError extends Error {}

// True for an address this server must never be made to call. Pure.
function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 4) return blocked.check(address, 'ipv4');
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, 'ipv6');
}

// Parse + check a user URL. Resolves the URL object, or throws UnsafeUrlError.
async function assertPublicUrl(raw, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new UnsafeUrlError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('only http(s) URLs are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new UnsafeUrlError('that host could not be found');
    }
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new UnsafeUrlError('that address is not reachable from here');
  }
  return url;
}

/**
 * Fetch a user-supplied URL. Returns { status, ok, headers, text } with the body read up
 * to maxBytes (longer bodies are cut, not rejected). Throws UnsafeUrlError for a URL or
 * redirect that fails the check, and the usual fetch errors otherwise.
 */
async function safeFetch(raw, { method = 'GET', headers, body, timeoutMs = 10000, maxBytes = 2_000_000, maxRedirects = 3 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let target = String(raw);
  for (let hop = 0; ; hop++) {
    const url = await assertPublicUrl(target);
    const res = await fetch(url, { method, headers, body, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= maxRedirects) throw new UnsafeUrlError('too many redirects');
      target = new URL(res.headers.get('location'), url).toString();
      // A redirected POST is re-sent as a GET, as browsers do for 301/302/303.
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      continue;
    }
    return { status: res.status, ok: res.ok, headers: res.headers, text: await readCapped(res, maxBytes) };
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

module.exports = { safeFetch, assertPublicUrl, isBlockedAddress, UnsafeUrlError };
