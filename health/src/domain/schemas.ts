import { z } from 'zod';
import { isIsoDate } from '../util/date.js';

// Validated MCP inputs. The `*Shape` objects are plain zod shapes so the
// tools can use them directly.

export const isoDate = z
  .string()
  .refine(isIsoDate, 'expected a date as YYYY-MM-DD');
const text = z.string().trim().min(1);
const clientId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .describe(
    'Client-generated id (UUID); resending the same id replaces the entry'
  );
export const issue = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .describe('Issue tag, lowercase with underscores, e.g. canker_sore');

export const flareShape = {
  id: clientId.optional(),
  date: isoDate.optional().describe('Default today (America/Chicago)'),
  issue,
  count: z.number().int().min(1).max(100).optional().describe('Default 1'),
  location: z
    .string()
    .trim()
    .optional()
    .describe('Free text, e.g. "lower lip, left"'),
  severity: z.number().min(0).max(10).optional().describe('0-10'),
  note: z.string().trim().optional(),
};
export const flareInput = z.object(flareShape);

export const mealsSchema = z
  .union([z.array(text), z.record(z.string().regex(/^[a-z_]+$/), text)])
  .describe(
    'A list of what was eaten, or text per meal: {breakfast: "...", lunch: "Just Salad", dinner: "..."}'
  );

export const dayShape = {
  date: isoDate.optional().describe('Default today (America/Chicago)'),
  sleepHours: z.number().min(0).max(24).nullable().optional(),
  alcohol: z.boolean().nullable().optional(),
  meals: mealsSchema.nullable().optional(),
  preparedFood: z
    .boolean()
    .nullable()
    .optional()
    .describe('Any restaurant, takeout or store-prepared food that day'),
  note: z.string().trim().nullable().optional(),
};
export const dayInput = z.object(dayShape);

export const experimentShape = {
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional()
    .describe('Existing experiment id; default: match by exact name'),
  name: text.optional().describe('Required for a new experiment'),
  issue: issue.optional().describe('Required for a new experiment'),
  rule: text
    .optional()
    .describe('The one change, in one sentence, e.g. "no Just Salad"'),
  start: isoDate.optional().describe('Default today for a new experiment'),
  end: isoDate
    .nullable()
    .optional()
    .describe('Last day of the experiment; null reopens it'),
};
export const experimentInput = z.object(experimentShape);
