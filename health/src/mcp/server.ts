import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodError } from 'zod';
import { StoreError, type HealthStore } from '../db/store.js';
import {
  dayShape,
  experimentShape,
  flareShape,
  isoDate,
  issue,
} from '../domain/schemas.js';

// Tools for Claude. Names go through mcp-gateway unprefixed next to the
// other apps' tools, so every one starts with health_.

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

/** Known, user-facing errors become tool errors; anything else propagates. */
async function guard<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StoreError) return fail(e.message);
    if (e instanceof ZodError)
      return fail(
        `Invalid input: ${e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`
      );
    throw e;
  }
}

export const INSTRUCTIONS = `Dan's recurring health issues (e.g. canker_sore) logged against possible triggers, separate from training. Log what Dan reports in chat: a flare with health_log_flare, the day's sleep, alcohol, meals and prepared food (restaurant/takeout/store-prepared) with health_log_day (one row per date; send only what he told you, it merges).
When a flare is logged, look back 1-3 days: health_log_flare returns those day logs; ask Dan about the days with nothing logged.
Keep one experiment active at a time (health_experiment: one change, e.g. "no Just Salad"; end it before starting the next). Judge it with health_report: flare rate during the experiment vs. the same-length period before it.
Never infer a trigger from a single flare: say what a pattern would need (repeats, an experiment) instead. Dates are YYYY-MM-DD in America/Chicago; today is the default.`;

const lookbackShape = {
  lookbackFrom: z
    .number()
    .int()
    .min(0)
    .max(14)
    .optional()
    .describe('Days before a flare the lookback starts (default 1)'),
  lookbackTo: z
    .number()
    .int()
    .min(0)
    .max(14)
    .optional()
    .describe('Days before a flare the lookback ends (default 3)'),
};

export function createMcpServer(store: HealthStore): McpServer {
  const server = new McpServer(
    { name: 'health', version: '1.0.0' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    'health_log_flare',
    {
      title: 'Log a flare',
      description:
        'A flare of a recurring issue (e.g. canker_sore) on a date: how many, where, severity 0-10. Give a client-generated id (UUID); resending that id replaces the entry. Returns the flare, the day logs from 1-3 days before it (null where nothing is logged) and the experiment active that day.',
      inputSchema: flareShape,
    },
    async (args) =>
      guard(async () => {
        const flare = await store.upsertFlare(args);
        return json({
          flare,
          lookback: await store.lookback(flare.date),
          experiment: await store.activeExperiment(flare.date),
        });
      })
  );

  server.registerTool(
    'health_log_day',
    {
      title: 'Log a day',
      description:
        "Possible triggers for one date (one row per date): sleepHours, alcohol, meals (a list, or text per meal), preparedFood (any restaurant, takeout or store-prepared food), note. Resending the date updates it: only the fields given change, meals per meal merge, null clears a field. Returns the day's row.",
      inputSchema: dayShape,
    },
    async (args) => guard(async () => json(await store.upsertDay(args)))
  );

  server.registerTool(
    'health_experiment',
    {
      title: 'Create, update or end an experiment',
      description:
        'One change tried against an issue: name, issue, rule (one sentence, e.g. "no Just Salad"), start (default today), end (optional; set it to end the experiment, null reopens it). Matches an existing experiment by id or exact name and changes only the fields given. Experiments may not overlap: end the active one first.',
      inputSchema: experimentShape,
    },
    async (args) => guard(async () => json(await store.upsertExperiment(args)))
  );

  server.registerTool(
    'health_report',
    {
      title: 'Flares, lookbacks and experiments',
      description:
        "For one issue from..to (default the last 8 weeks): each flare with the day logs from its lookback window (default 1-3 days before) and the experiment active that day; totals and flares per week; and for each of the issue's experiments in the range, the flare rate during it (through its end or today) vs. the same-length period just before it (beforeOverlaps names other experiments in that baseline).",
      inputSchema: {
        issue,
        from: isoDate.optional(),
        to: isoDate.optional(),
        ...lookbackShape,
      },
    },
    async ({ issue, from, to, lookbackFrom, lookbackTo }) =>
      guard(async () =>
        json(
          await store.report(issue, from, to, {
            minDays: lookbackFrom ?? 1,
            maxDays: lookbackTo ?? 3,
          })
        )
      )
  );

  return server;
}
