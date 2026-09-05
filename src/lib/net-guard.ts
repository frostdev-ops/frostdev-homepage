import dns from 'node:dns/promises';
import net from 'node:net';

// The private-address check the agent's vettedFetch has always used, lifted out
// so the mailbox connector (arbitrary user-supplied IMAP/POP/SMTP hosts) shares
// exactly one implementation with it.

/** RFC1918 + loopback + link-local + CGNAT + unique-local v6. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateAddress(mapped[1]!) : false;
}

/**
 * Resolve a hostname and refuse anything landing on a private address. Returns
 * the ONE address that passed: connect to exactly that and pass the hostname as
 * the TLS servername. Resolving twice (once to check, once to connect) is a
 * DNS-rebinding hole — a TTL-0 domain answers public here and 127.0.0.1 there.
 */
/** A target this guard will not let anyone reach — the caller's fault, never the network's. */
export class RefusedError extends Error {}

export async function publicAddress(host: string): Promise<string> {
  const h = host.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (!addresses.length) throw new RefusedError(`${host} did not resolve`);
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new RefusedError(`refused: ${host} resolves to the private address ${a.address}`);
  }
  return addresses[0]!.address;
}
