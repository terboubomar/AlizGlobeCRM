import {
  whatsappConfig,
  verifyWhatsAppChallenge,
  validWhatsAppSignature,
  applyWhatsAppStatus,
} from './whatsapp';
import { complaintReport, exportReport } from './reports';
import {
  telegramConfig,
  telegramAccount,
  beginTelegramLinkTx,
  receiveTelegramTx,
  confirmTelegramTx,
  disconnectTelegramTx,
  validTelegramSecret,
} from './telegram';
import { saveShift, cancelShift, saveBulkShifts, reviewLeaveTx } from './scheduling';
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  Module,
  Controller,
  Get,
  Header,
  Post,
  Param,
  Req,
  Res,
  Body,
  UseInterceptors,
  UploadedFiles,
  All,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Request, Response, NextFunction } from 'express';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../../../packages/db/client';
import { authorize, can, DomainError } from '../../../packages/domain/src';
import {
  actor,
  demoSession,
  endStaffSession,
  isDemo,
  passwordAuthEnabled,
  passwordSession,
} from './auth';
import * as service from './service';
import { searchComplaints } from './complaint-search';
import { listUsers, saveUser, userStatus } from './users';
import { oidcReady, startOidc, finishOidc } from './oidc';
import { rateLimit, trustedProxies, closeRateLimiter } from './rate-limit';
import { upload, download, File } from './uploads';
import { decrypt, phoneHash } from './crypto';
import { saveBrand, updateBranch, deleteDirectoryEntry, directoryStatusTx } from './directory';
import { normalizePhone } from '../../../packages/domain/src';
@Controller('api')
class Api {
  @Get('health') async health() {
    await db.$queryRaw`SELECT 1`;
    return { ok: true, mode: isDemo() ? 'DEMO' : 'PRODUCTION' };
  }
  @Get('session') async session(@Req() req: Request) {
    return { me: await actor(req), demo: isDemo() };
  }
  @Get('users')
  @Header('Cache-Control', 'no-store')
  async managedUsers(@Req() req: Request) {
    return listUsers(await actor(req));
  }
  @Post('users') async createUser(@Req() req: Request, @Body() body: unknown) {
    return saveUser(await actor(req), body);
  }
  @Post('users/:id') async updateUser(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return saveUser(await actor(req), body, id);
  }
  @Post('users/:id/status') async setUserStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return userStatus(await actor(req), id, body);
  }
  @Get('demo-users') async users() {
    if (!isDemo() || passwordAuthEnabled()) throw new DomainError('NOT_FOUND', 404, 'غير متاح');
    return db.user.findMany({
      select: { id: true, name: true, role: true },
      where: { enabled: true, passwordHash: null, role: { not: 'SUPER_ADMIN' } },
    });
  }
  @Post('login') async passwordLogin(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.cookie(
      'aliz_session',
      await passwordSession(body, req.ip ?? req.socket.remoteAddress ?? 'unknown'),
      {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 4 * 3600000,
        path: '/',
      },
    );
    return { ok: true };
  }
  @Get('auth/options') authOptions() {
    return {
      mode: passwordAuthEnabled() || isDemo() ? 'password' : 'oidc',
      available: passwordAuthEnabled() || (!isDemo() && oidcReady()),
    };
  }
  @Get('auth/oidc/start') async oidcStart(@Req() req: Request, @Res() res: Response) {
    if (passwordAuthEnabled() || isDemo())
      throw new DomainError('SSO_UNAVAILABLE', 409, 'تسجيل الدخول المؤسسي غير مفعّل');
    const result = await startOidc(req.query.returnTo);
    res.cookie('aliz_oidc', result.cookie, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600000,
      path: '/api/auth/oidc',
    });
    return res.redirect(302, result.url);
  }
  @Get('auth/oidc/callback') async oidcCallback(@Req() req: Request, @Res() res: Response) {
    res.clearCookie('aliz_oidc', {
      path: '/api/auth/oidc',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    try {
      const result = await finishOidc(req.cookies?.aliz_oidc ?? '', req.query);
      res.cookie('aliz_session', result.session, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 4 * 3600000,
        path: '/',
      });
      return res.redirect(303, result.returnTo);
    } catch {
      return res.redirect(303, '/?authError=oidc_failed');
    }
  }
  @Post('demo-login') async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { id } = z.object({ id: z.string() }).parse(body);
    res.cookie('aliz_session', await demoSession(id), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 4 * 3600000,
      path: '/',
    });
    return { ok: true };
  }
  @Post('logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await endStaffSession(req);
    res.clearCookie('aliz_session', { path: '/' });
    return { ok: true };
  }
  @Get('bootstrap') async bootstrap(@Req() req: Request) {
    const data = await service.bootstrap(await actor(req));
    return {
      ...data,
      tasks: data.tasks.map((t) => ({ ...t, note: undefined })),
      tickets: data.tickets.map((t) => ({
        ...t,
        tasks: t.tasks.map((task) => ({ ...task, note: undefined })),
      })),
    };
  }
  @Post('tickets/phone') async phone(@Req() req: Request, @Body() body: unknown) {
    return service.createTicket(
      await actor(req),
      body,
      String(req.headers['idempotency-key'] ?? ''),
    );
  }
  @Get('tickets/search')
  @Header('Cache-Control', 'no-store')
  async complaintLookup(@Req() req: Request) {
    return searchComplaints(await actor(req), req.query);
  }
  @Get('tickets/:id') async ticket(@Req() req: Request, @Param('id') id: string) {
    const a = await actor(req);
    return service.present(await service.getTicket(a, id), a);
  }
  @Post('tickets/:id/actions/:action') async action(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    return service.ticketAction(await actor(req), id, action, body);
  }
  @Post('refunds') async refund(@Req() req: Request, @Body() body: unknown) {
    return service.requestRefund(await actor(req), body);
  }
  @Post('refunds/:id/:action') async refundAction(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    return service.refundAction(await actor(req), id, action, body);
  }
  @Post('brands') async createBrand(@Req() req: Request, @Body() body: unknown) {
    return saveBrand(await actor(req), body);
  }
  @Post('brands/:id/status') async brandStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const a = await actor(req);
    return db.$transaction((tx) => directoryStatusTx(tx, a, 'brand', id, body));
  }
  @Post('branches/:id/status') async branchStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const a = await actor(req);
    return db.$transaction((tx) => directoryStatusTx(tx, a, 'branch', id, body));
  }
  @Post('brands/:id/delete') async deleteBrand(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return deleteDirectoryEntry(await actor(req), 'brand', id, body);
  }
  @Post('branches/:id/delete') async deleteBranch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return deleteDirectoryEntry(await actor(req), 'branch', id, body);
  }
  @Post('brands/:id') async editBrand(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return saveBrand(await actor(req), body, id);
  }
  @Post('branches/:id') async editBranch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return updateBranch(await actor(req), id, body);
  }
  @Post('refunds/:id/evidence/images')
  @UseInterceptors(
    FilesInterceptor('files', 3, { limits: { fileSize: 5 * 1024 * 1024, files: 3 } }),
  )
  async refundImages(@Req() req: Request, @Param('id') id: string, @UploadedFiles() files: File[]) {
    return upload(id, files, await actor(req), undefined, true);
  }
  @Post('branches') async branch(@Req() req: Request, @Body() body: unknown) {
    return service.createBranch(await actor(req), body);
  }
  @Post('tasks') async task(@Req() req: Request, @Body() body: unknown) {
    return service.createTask(await actor(req), body);
  }
  @Post('tasks/:id/complete') async taskDone(@Req() req: Request, @Param('id') id: string) {
    return service.completeTask(await actor(req), id);
  }
  @Post('shifts') async shift(@Req() req: Request, @Body() body: unknown) {
    return service.createShift(await actor(req), body);
  }
  @Post('shifts/bulk') async bulkShifts(@Req() req: Request, @Body() body: unknown) {
    return saveBulkShifts(await actor(req), body);
  }
  @Post('shifts/:id/update') async updateShift(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return saveShift(await actor(req), body, id);
  }
  @Post('shifts/:id/cancel') async cancelShiftRoute(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return cancelShift(await actor(req), id, body);
  }
  @Post('leave') async leave(@Req() req: Request, @Body() body: unknown) {
    const a = await actor(req);
    if (!can(a, 'schedule') && !can(a, 'schedule.self'))
      throw new DomainError('FORBIDDEN', 403, 'غير مصرح بطلب إجازة.');
    const b = z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).parse(body);
    if (b.start >= b.end) throw new DomainError('INVALID_DATES', 400, 'نطاق غير صحيح');
    return db.$transaction(async (tx) => {
      const l = await tx.leave.create({ data: { userId: a.id, ...b } });
      await service.audit(tx, a, 'LEAVE_REQUESTED', l.id);
      return l;
    });
  }
  @Post('leave/:id/:action') async leaveAction(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('action') action: string,
  ) {
    const a = await actor(req);
    return db.$transaction((tx) => reviewLeaveTx(tx, a, id, action));
  }
  @Get('qrs') async qrs(@Req() req: Request) {
    const a = await actor(req);
    authorize(a, 'configure');
    const qrs = await db.qr.findMany({
      where: {
        branch: {
          brandId: { in: a.brandIds },
          ...(a.branchIds.length ? { id: { in: a.branchIds } } : {}),
        },
      },
      select: {
        id: true,
        branchId: true,
        placement: true,
        active: true,
        scans: true,
        createdAt: true,
        revokedAt: true,
        codeEncrypted: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return qrs.map(({ codeEncrypted, ...q }) => ({ ...q, reusable: !!codeEncrypted }));
  }
  @Post('qrs') async qr(@Req() req: Request, @Body() body: unknown) {
    return service.qrCreate(await actor(req), body);
  }
  @Get('qrs/:id/link')
  @Header('Cache-Control', 'no-store')
  async qrLink(@Req() req: Request, @Param('id') id: string) {
    return service.qrLink(await actor(req), id);
  }
  @Post('qrs/:id/:action') async qrRevoke(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('action') action: string,
  ) {
    return service.qrAction(await actor(req), id, action);
  }
  @Post('qa') async qa(@Req() req: Request, @Body() body: unknown) {
    const a = await actor(req);
    authorize(a, 'qa');
    const b = z
      .object({
        ticketId: z.string(),
        score: z.number().int().min(0).max(100),
        note: z.string().trim().min(5).max(1000),
      })
      .parse(body);
    await service.getTicket(a, b.ticketId);
    return db.$transaction(async (tx) => {
      const r = await tx.review.create({ data: { ...b, reviewer: a.id } });
      await service.audit(tx, a, 'QA_REVIEWED', b.ticketId);
      return r;
    });
  }
  @Get('audit') async audit(@Req() req: Request) {
    const a = await actor(req);
    authorize(a, 'audit');
    if (!['SUPER_ADMIN', 'ADMIN'].includes(a.role))
      throw new DomainError('FORBIDDEN', 403, 'سجل الإدارة متاح لمسؤول النظام');
    return db.audit.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  }
  @Get('reports')
  @Header('Cache-Control', 'no-store')
  async report(@Req() req: Request) {
    return complaintReport(await actor(req), req.query);
  }
  @Get('reports/export') async export(@Req() req: Request, @Res() res: Response) {
    const csv = await exportReport(await actor(req), req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aliz-complaints.csv"');
    res.send(csv);
  }
  @Post('customers/search') async customers(@Req() req: Request, @Body() body: unknown) {
    const a = await actor(req);
    authorize(a, 'pii');
    if (a.role === 'AGENT')
      throw new DomainError('FORBIDDEN', 403, 'بيانات العميل متاحة من الشكوى المسندة إليك');
    const phone = z
      .string()
      .min(9)
      .max(15)
      .parse(z.object({ phone: z.string() }).parse(body).phone);
    const tickets = await db.ticket.findMany({
      where: { ...service.scope(a), phoneHash: phoneHash(normalizePhone(phone)) },
      include: { brand: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    await db.audit.create({ data: { actor: a.id, action: 'CUSTOMER_LOOKUP', entityId: 'SCOPED' } });
    return tickets.map((t) => ({
      id: t.id,
      number: service.num(t),
      customer: t.customer ? JSON.parse(decrypt(t.customer)) : null,
      state: t.state,
      brand: t.brand.name,
    }));
  }
  @Post('tickets/:id/attachments')
  @UseInterceptors(
    FilesInterceptor('files', 3, { limits: { fileSize: 5 * 1024 * 1024, files: 3 } }),
  )
  async attachments(@Req() req: Request, @Param('id') id: string, @UploadedFiles() files: File[]) {
    return upload(id, files, await actor(req));
  }
  @Get('attachments/:id') async attachment(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    res.type('webp').send(await download(await actor(req), id));
  }
  @Get('integrations/telegram/account') async telegramAccountStatus(@Req() req: Request) {
    return telegramAccount(await actor(req));
  }
  @Post('integrations/telegram/link') async telegramLink(@Req() req: Request) {
    const a = await actor(req);
    return db.$transaction((tx) => beginTelegramLinkTx(tx, a));
  }
  @Post('integrations/telegram/confirm') async telegramConfirm(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const a = await actor(req);
    return db.$transaction((tx) => confirmTelegramTx(tx, a, body));
  }
  @Post('integrations/telegram/disconnect') async telegramDisconnect(@Req() req: Request) {
    const a = await actor(req);
    return db.$transaction((tx) => disconnectTelegramTx(tx, a));
  }
  @Get('integrations/telegram') async telegramIntegration(@Req() req: Request) {
    authorize(await actor(req), 'users.manage');
    const counts = await db.telegramNotification.groupBy({ by: ['status'], _count: true });
    const users = await db.user.findMany({
      where: { enabled: true },
      select: { id: true, name: true, role: true, telegram: { select: { linkedAt: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      ...telegramConfig(),
      statuses: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      users: users.map(({ telegram, ...u }) => ({ ...u, linked: !!telegram?.linkedAt })),
    };
  }
  @Post('integrations/telegram/webhook') async telegramWebhook(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    if (
      !telegramConfig().ready ||
      !validTelegramSecret(req.get('X-Telegram-Bot-Api-Secret-Token') ?? '')
    )
      throw new DomainError('FORBIDDEN', 403, 'غير مصرح');
    await db.$transaction((tx) => receiveTelegramTx(tx, body));
    return { ok: true };
  }
  @Get('integrations/whatsapp') async whatsappIntegration(@Req() req: Request) {
    const a = await actor(req);
    authorize(a, 'users.manage');
    const statuses = await db.complaintConfirmation.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return {
      ...whatsappConfig(),
      statuses: Object.fromEntries(statuses.map((s) => [s.status, s._count._all])),
    };
  }
  @Get('integrations/whatsapp/webhook') async verifyWhatsApp(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.type('text/plain').send(verifyWhatsAppChallenge(req.query));
  }
  @Post('integrations/whatsapp/webhook') async whatsappStatus(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw || !validWhatsAppSignature(raw, String(req.headers['x-hub-signature-256'] ?? '')))
      throw new DomainError('FORBIDDEN', 403, 'غير مصرح');
    await applyWhatsAppStatus(body);
    return { ok: true };
  }
  @Get('public/q/:code') async publicQr(@Param('code') code: string) {
    const q = await service.publicQr(code, true);
    return {
      branch: q.branch.name,
      brand: q.branch.brand.name,
      logo: q.branch.brand.logo,
      demo: isDemo(),
      whatsappAvailable: whatsappConfig().ready,
    };
  }
  @Post('public/q/:code') async publicTicket(
    @Req() req: Request,
    @Param('code') code: string,
    @Body() body: unknown,
  ) {
    return service.publicCreate(code, body, String(req.headers['idempotency-key'] ?? ''));
  }
  @Get('public/status/:token') async status(@Param('token') token: string) {
    return service.status(token);
  }
  @Post('public/attachments/:id')
  @UseInterceptors(
    FilesInterceptor('files', 3, { limits: { fileSize: 5 * 1024 * 1024, files: 3 } }),
  )
  async publicImages(@Req() req: Request, @Param('id') id: string, @UploadedFiles() files: File[]) {
    return upload(id, files, undefined, String(req.headers['x-case-token'] ?? ''));
  }
  @All('{*path}') missing() {
    throw new DomainError('NOT_FOUND', 404, 'المسار غير موجود');
  }
}
@Module({ controllers: [Api] })
class AppModule {}
async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE === 'true')
    throw new Error('DEMO_MODE prohibited in production');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  const proxies = trustedProxies();
  if (
    process.env.NODE_ENV === 'production' &&
    (!proxies || process.env.PROXY_HEADERS_SANITIZED !== 'true')
  )
    throw new Error(
      'Configure trusted proxy addresses and sanitized forwarding headers before production',
    );
  app.getHttpAdapter().getInstance().set('trust proxy', proxies);
  app.use(helmet());
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '64kb',
      verify: (req, _res, buffer) => {
        (req as Request & { rawBody: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== process.env.APP_ORIGIN && !isDemo())
        return res.status(403).json({ code: 'CSRF', message: 'مصدر الطلب غير مسموح' });
      if (
        origin &&
        isDemo() &&
        !['http://localhost:3000', 'http://127.0.0.1:3000', process.env.APP_ORIGIN].includes(origin)
      )
        return res.status(403).json({ code: 'CSRF', message: 'مصدر الطلب غير مسموح' });
    }
    next();
  });
  app.use(rateLimit);
  app.useGlobalFilters({
    catch(e: unknown, host) {
      const res = host.switchToHttp().getResponse<Response>();
      if (e instanceof DomainError)
        return res.status(e.status).json({ code: e.code, message: e.message });
      if (e instanceof z.ZodError)
        return res.status(400).json({
          code: 'VALIDATION',
          message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('، '),
        });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        return res
          .status(409)
          .json({ code: 'CONFLICT', message: 'السجل موجود أو تم إرسال الطلب سابقاً؛ حدّث الصفحة' });
      const err = e as { status?: number; getStatus?: () => number };
      const status = err.getStatus?.() ?? 500;
      return res.status(status).json({
        code: 'REQUEST_ERROR',
        message:
          status === 413
            ? 'حجم الملف أكبر من المسموح'
            : 'تعذر إتمام الطلب. حاول مرة أخرى أو تواصل مع مسؤول النظام',
      });
    },
  });
  await app.listen(Number(process.env.API_PORT ?? 4000), process.env.API_HOST ?? '127.0.0.1');
  const stop = () => {
    closeRateLimiter();
    void app.close().finally(() => db.$disconnect());
  };
  process.on('SIGTERM', stop);
}
main().catch(() => {
  process.stderr.write('API startup failed. Check database and environment configuration.\n');
  process.exit(1);
});
