import { randomUUID } from 'node:crypto';

type RequestInfo = { method: string; route?: { path?: unknown } };

// Log line for an unexpected server error. Error messages and request data can
// carry customer details (Prisma errors quote column values), so only the error
// type, code, route pattern and stack frames are kept. The reference is also
// returned to the client so support can match a report to this line.
export function errorLogEntry(
  e: unknown,
  req: RequestInfo,
  status: number,
  ref = randomUUID().slice(0, 8),
) {
  const err = e instanceof Error ? e : undefined;
  const code = (e as { code?: unknown } | null)?.code;
  return {
    level: 'error',
    ref,
    status,
    method: req.method,
    // The pattern (/api/tickets/:id), never the URL, which can hold IDs and tokens.
    route: typeof req.route?.path === 'string' ? req.route.path : '(unmatched)',
    error: err ? err.constructor.name : typeof e,
    ...(typeof code === 'string' ? { code } : {}),
    // Frames only: the first stack line repeats the message.
    at: (err?.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .slice(0, 5),
  };
}
