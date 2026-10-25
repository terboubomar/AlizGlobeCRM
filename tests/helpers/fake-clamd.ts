import { createServer, type AddressInfo } from 'node:net';

/** A stand-in clamd that answers INSTREAM like the real one. */
export async function fakeClamd(answer: (body: Buffer) => string | null) {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (c) => {
      buffer = Buffer.concat([buffer, c]);
      const start = buffer.indexOf('zINSTREAM\0');
      if (start !== 0) return;
      let at = 10;
      const parts: Buffer[] = [];
      while (at + 4 <= buffer.length) {
        const size = buffer.readUInt32BE(at);
        if (size === 0) {
          const reply = answer(Buffer.concat(parts));
          if (reply !== null) socket.end(reply + '\0');
          return;
        }
        if (at + 4 + size > buffer.length) return;
        parts.push(buffer.subarray(at + 4, at + 4 + size));
        at += 4 + size;
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { url: `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
