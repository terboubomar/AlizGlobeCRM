import type { NextFunction, Request, Response } from 'express';
import type { RequestWithId } from './request-id';

// One JSON object per line on stdout/stderr, so any log platform (CloudWatch,
// Loki, Datadog, Elastic...) can collect and alert on it without parsing text.
// Entries carry route patterns, codes and counts only: never URLs, request or
// response bodies, error messages, names, phone numbers or tokens.

type Level = 'info' | 'warn' | 'error';
type Value = string | number | boolean | null | undefined | string[];
export type LogEntry = { level: Level; event: string; [field: string]: Value };

const service = () => process.env.LOG_SERVICE ?? 'api';

export function formatLog(entry: LogEntry, now = new Date()) {
  const line: Record<string, Value> = { time: now.toISOString(), service: service() };
  for (const [key, value] of Object.entries(entry)) if (value !== undefined) line[key] = value;
  return JSON.stringify(line);
}

export function log(entry: LogEntry) {
  const line = formatLog(entry) + '\n';
  if (entry.level === 'info') process.stdout.write(line);
  else process.stderr.write(line);
}

/** The matched route pattern (/api/tickets/:id), never the concrete URL. */
export function routePattern(req: Pick<Request, 'baseUrl'> & { route?: { path?: unknown } }) {
  return typeof req.route?.path === 'string' ? (req.baseUrl ?? '') + req.route.path : '(unmatched)';
}

const quiet = new Set(['/api/health']);

/** Access log: one line per finished request, with the request ID for tracing. */
export function requestLog(req: Request, res: Response, next: NextFunction) {
  if (process.env.LOG_REQUESTS === 'false') return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = routePattern(req);
    if (quiet.has(route) && res.statusCode < 400) return;
    log({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      event: 'request',
      requestId: (req as RequestWithId).requestId,
      method: req.method,
      route,
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    });
  });
  next();
}

/** Error type and code only; messages can quote customer data (e.g. Prisma column values). */
export function errorKind(e: unknown) {
  const code = (e as { code?: unknown } | null)?.code;
  return {
    error: e instanceof Error ? e.constructor.name : typeof e,
    ...(typeof code === 'string' ? { code } : {}),
  };
}
