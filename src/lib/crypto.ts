import crypto from 'node:crypto';

// Refresh tokens grant standing mailbox access and the DB file travels in
// nightly backups, so long-lived credentials are sealed at rest. Access tokens
// (≤1h) are not worth the ceremony.

function key(): Buffer {
  const b64 = (process.env.TOKEN_ENC_KEY ?? '').trim();
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes of base64 (openssl rand -base64 32)');
  return k;
}

/** AES-256-GCM. Output "iv.ct.tag", each base64. */
export function sealToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${ct.toString('base64')}.${cipher.getAuthTag().toString('base64')}`;
}

export function openToken(sealed: string): string {
  const [ivB64, ctB64, tagB64] = sealed.split('.');
  if (!ivB64 || !ctB64 || !tagB64) throw new Error('malformed sealed token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
