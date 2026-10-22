import { z } from 'zod';
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .optional();
const coordinate = (min: number, max: number) =>
  z
    .preprocess(
      (v) =>
        v === '' || v === undefined || v === null ? null : typeof v === 'string' ? Number(v) : v,
      z.number().min(min).max(max).nullable(),
    )
    .optional();
export const branchLocationFields = {
  district: optionalText(100),
  address: optionalText(300),
  mapsUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => {
      if (!v) return true;
      try {
        const u = new URL(v);
        return u.protocol === 'https:' && !u.username && !u.password;
      } catch {
        return false;
      }
    }, 'أدخل رابط خريطة صالحاً يبدأ بـ https://')
    .transform((v) => v || null)
    .optional(),
  latitude: coordinate(-90, 90),
  longitude: coordinate(-180, 180),
  phone: z
    .string()
    .trim()
    .max(25)
    .refine((v) => !v || /^\+?[0-9 ()-]{7,25}$/.test(v), 'أدخل رقم هاتف صالحاً')
    .transform((v) => v || null)
    .optional(),
};
export const pairedCoordinates = (v: { latitude?: number | null; longitude?: number | null }) =>
  (v.latitude == null) === (v.longitude == null);
