import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type RequestWithId = Request & { requestId?: string };

const allowed = /^[A-Za-z0-9._-]{8,128}$/;

// Reuse the edge proxy's ID (nginx $request_id) so one request can be traced
// from the access log to the API log; otherwise mint one. The value is echoed
// in a header and written to logs, so anything else is replaced.
export function requestIdFor(incoming: unknown) {
  return typeof incoming === 'string' && allowed.test(incoming) ? incoming : randomUUID();
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = requestIdFor(req.headers['x-request-id']);
  (req as RequestWithId).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
