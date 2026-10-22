import { z } from 'zod';
import { DomainError } from '../../../packages/domain/src';
import { isDemo } from './auth';
const minutes = z.number().int().min(1).max(10080);
const schema = z.object({
  version: z.string().min(1).max(100),
  p1First: minutes,
  p1Ack: minutes,
  p2First: minutes,
  p2Ack: minutes,
  p2Remedy: minutes,
  p3First: minutes,
  p3Ack: minutes,
  p3Remedy: minutes,
});
export type SlaPolicy = z.infer<typeof schema>;
export const demoSla: SlaPolicy = {
  version: 'PROPOSED-DEMO-V1',
  p1First: 5,
  p1Ack: 5,
  p2First: 5,
  p2Ack: 5,
  p2Remedy: 30,
  p3First: 15,
  p3Ack: 30,
  p3Remedy: 240,
};
export function slaPolicy(snapshot?: unknown): SlaPolicy {
  if (snapshot) return schema.parse(snapshot);
  if (isDemo()) return demoSla;
  const raw = {
    version: process.env.SLA_POLICY_VERSION,
    ...Object.fromEntries(
      ['p1First', 'p1Ack', 'p2First', 'p2Ack', 'p2Remedy', 'p3First', 'p3Ack', 'p3Remedy'].map(
        (key) => [
          key,
          Number(process.env['SLA_' + key.replace(/([A-Z])/g, '_$1').toUpperCase() + '_MINUTES']),
        ],
      ),
    ),
  };
  const parsed = schema.safeParse(raw);
  if (process.env.SLA_POLICY_APPROVED !== 'true' || !parsed.success)
    throw new DomainError('SLA_POLICY_PENDING', 503, 'سياسة مهل الشكاوى بانتظار التهيئة والاعتماد');
  return parsed.data;
}
export function slaMilestones(
  priority: string,
  received: Date,
  policy: SlaPolicy,
  assigned?: Date,
) {
  const prefix = priority === 'P1' ? 'p1' : priority === 'P2' ? 'p2' : 'p3';
  const timer = (milestone: string, start: Date, duration: number) => ({
    milestone,
    dueAt: new Date(+start + duration * 60000),
    warningAt: new Date(+start + duration * 48000),
  });
  return [
    timer('FIRST_ACTION', received, policy[`${prefix}First`]),
    ...(assigned ? [timer('ACKNOWLEDGMENT', assigned, policy[`${prefix}Ack`])] : []),
    ...(priority === 'P1'
      ? []
      : [timer('REMEDY', received, priority === 'P2' ? policy.p2Remedy : policy.p3Remedy)]),
  ];
}
