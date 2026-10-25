import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

// Malware scan for uploads. MALWARE_SCANNER is either a clamd address
// (tcp://clamav:3310, the production setup: ClamAV runs as its own service
// with signatures kept current by freshclam) or the path to a local
// clamscan-compatible command.

export type ScanResult = { clean: true } | { clean: false; signature: string };

const CHUNK = 64 * 1024;

/** clamd INSTREAM: length-prefixed chunks, then a zero-length chunk. */
export function scanWithClamd(target: string, data: Buffer, timeoutMs = 30000) {
  const url = new URL(target);
  if (url.protocol !== 'tcp:' || !url.hostname || !url.port)
    throw new Error('MALWARE_SCANNER must look like tcp://host:3310');
  return new Promise<ScanResult>((done, fail) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Malware scanner timed out')));
    socket.on('error', fail);
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim();
      // "stream: OK" | "stream: <signature> FOUND" | "... ERROR"
      if (reply === 'stream: OK') return done({ clean: true });
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (found) return done({ clean: false, signature: found[1] });
      fail(new Error('Malware scanner error'));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK),
          size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        socket.write(size);
        socket.write(part);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}

async function scanWithCommand(command: string, data: Buffer): Promise<ScanResult> {
  const dir = resolve(tmpdir(), 'aliz-scan');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const raw = resolve(dir, randomUUID() + '.quarantine');
  await writeFile(raw, data, { flag: 'wx', mode: 0o600 });
  try {
    await promisify(execFile)(command, ['--no-summary', raw], { timeout: 30000 });
    return { clean: true };
  } catch (e) {
    // clamscan exits 1 when it finds something, 2 on errors.
    if ((e as { code?: unknown }).code === 1) return { clean: false, signature: 'detected' };
    throw new Error('Malware scanner error');
  } finally {
    await unlink(raw).catch(() => {});
  }
}

export function scan(data: Buffer, scanner = process.env.MALWARE_SCANNER) {
  if (!scanner) throw new Error('No malware scanner configured');
  return scanner.startsWith('tcp://')
    ? scanWithClamd(scanner, data)
    : scanWithCommand(scanner, data);
}
