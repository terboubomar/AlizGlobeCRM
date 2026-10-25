import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { db } from '../../../packages/db/client';
import {
  DomainError,
  Actor,
  authorize,
  isComplaintParticipant,
} from '../../../packages/domain/src';
import { hash } from './crypto';
import { isDemo } from './auth';
import { getTicket } from './service';
import { getRefund } from './refunds';
import { getFile, putFile, removeFile } from './storage';
import { scan } from './scanner';
import { log, errorKind } from './log';
export type File = { buffer: Buffer; size: number; mimetype: string };
export async function upload(
  id: string,
  files: File[],
  a?: Actor,
  trackingToken?: string,
  refundMode = false,
) {
  if (a) {
    const t = refundMode ? await getRefund(a, id) : await getTicket(a, id);
    authorize(a, refundMode ? 'evidence.attach' : 'comment', t);
    if (!refundMode && 'creator' in t && a.role === 'AGENT' && !isComplaintParticipant(a, t))
      throw new DomainError('OWNER_REQUIRED', 403, 'إضافة المرفقات متاحة لمسؤول الشكوى أو مسجلها');
  } else {
    const access = await db.access.findUnique({
      where: { hash: hash(trackingToken ?? '') },
      include: { ticket: true },
    });
    if (
      !access ||
      access.ticketId !== id ||
      access.expiresAt < new Date() ||
      Date.now() - +access.ticket.createdAt > 10 * 60000
    )
      throw new DomainError('FORBIDDEN', 403, 'انتهت جلسة إرفاق الصور');
  }
  if (!files.length || files.length > 3)
    throw new DomainError('FILE_COUNT', 400, 'أرفق من صورة إلى ثلاث صور');
  const prepared: {
    key: string;
    mime: string;
    size: number;
    checksum: string;
    status: string;
    ticketId: string | null;
    refundId: string | null;
  }[] = [];
  try {
    for (const file of files) {
      if (
        file.size > 5 * 1024 * 1024 ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
      )
        throw new DomainError('INVALID_IMAGE', 400, 'يسمح بصور JPG وPNG وWebP حتى 5 ميغابايت');
      const magic = file.buffer;
      const real =
        magic[0] === 0xff && magic[1] === 0xd8
          ? 'image/jpeg'
          : magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? 'image/png'
            : magic.subarray(0, 4).toString() === 'RIFF' &&
                magic.subarray(8, 12).toString() === 'WEBP'
              ? 'image/webp'
              : '';
      if (real !== file.mimetype)
        throw new DomainError('MIME_MISMATCH', 400, 'نوع الصورة لا يطابق محتواها');
      const key = randomUUID() + '.webp';
      if (!isDemo()) {
        if (!process.env.MALWARE_SCANNER)
          throw new DomainError('SCANNER_UNAVAILABLE', 503, 'فحص الملفات غير متاح حالياً');
        const result = await scan(file.buffer).catch((e: unknown) => {
          log({ level: 'error', event: 'malware_scan_failed', ...errorKind(e) });
          throw new DomainError('SCANNER_UNAVAILABLE', 503, 'فحص الملفات غير متاح حالياً');
        });
        if (!result.clean) {
          log({ level: 'warn', event: 'malware_rejected', signature: result.signature });
          throw new DomainError('MALWARE_FOUND', 422, 'تعذر قبول الملف بعد الفحص الأمني');
        }
      }
      const clean = await sharp(file.buffer, { limitInputPixels: 20000000, animated: false })
        .rotate()
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      await putFile(key, clean);
      prepared.push({
        key,
        mime: 'image/webp',
        size: clean.length,
        checksum: hash(clean.toString('base64')),
        status: isDemo() ? 'CLEAN_DEMO' : 'CLEAN',
        ticketId: refundMode ? null : id,
        refundId: refundMode ? id : null,
      });
    }
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const count = await tx.attachment.count({
        where: refundMode ? { refundId: id } : { ticketId: id },
      });
      if (count + prepared.length > 3)
        throw new DomainError('FILE_COUNT', 400, 'الحد الأعلى ثلاث صور لكل بلاغ');
      await tx.attachment.createMany({ data: prepared });
      if (refundMode) {
        await tx.refundEvent.create({
          data: { refundId: id, actor: a!.id, type: 'EVIDENCE_ATTACHED' },
        });
        await tx.audit.create({
          data: { actor: a!.id, action: 'REFUND_EVIDENCE_ATTACHED', entityId: id },
        });
      } else
        await tx.event.create({
          data: { ticketId: id, actor: a?.id ?? 'PUBLIC_QR', type: 'EVIDENCE_ATTACHED' },
        });
      return { ok: true };
    });
  } catch (e) {
    await Promise.all(prepared.map((f) => removeFile(f.key).catch(() => {})));
    throw e;
  }
}
export async function download(a: Actor, id: string) {
  const f = await db.attachment.findUnique({ where: { id } });
  if (!f) throw new DomainError('NOT_FOUND', 404, 'المرفق غير متاح');
  if (f.ticketId) authorize(a, 'pii', await getTicket(a, f.ticketId));
  else if (f.refundId) authorize(a, 'evidence.view', await getRefund(a, f.refundId));
  else throw new DomainError('NOT_FOUND', 404, 'المرفق غير متاح');
  if (!['CLEAN', ...(isDemo() ? ['CLEAN_DEMO'] : [])].includes(f.status))
    throw new DomainError('QUARANTINED', 403, 'المرفق قيد الفحص');
  await db.audit.create({ data: { actor: a.id, action: 'EVIDENCE_VIEWED', entityId: id } });
  return getFile(f.key);
}
