import { z } from 'zod';
import { BET_SPORTS, BOOST_KINDS, MARKETS, SELECTION_KINDS } from './types.js';

// Structured bet input shared by the seed loader and the MCP add_bet tool.
// Units at this edge: dollars and American odds.

const american = z
  .number()
  .int()
  .refine(
    (n) => n <= -100 || n >= 100,
    'American odds must be <= -100 or >= +100'
  );

const dollars = z.number().positive().multipleOf(0.01);

export const legInputSchema = z
  .object({
    sport: z.enum(BET_SPORTS),
    /** Local (America/Chicago) date of the event. */
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    /** The two teams/fighters, any order. */
    participants: z.tuple([z.string().min(1), z.string().min(1)]),
    eventLabel: z.string().min(1).optional(),
    market: z.enum(MARKETS),
    selection: z.object({
      kind: z.enum(SELECTION_KINDS),
      /** Required when kind = team: which participant is backed. */
      team: z.string().min(1).optional(),
    }),
    /** Spread from the selection's perspective, or the total. */
    line: z.number().optional(),
    price: american,
  })
  .superRefine((leg, ctx) => {
    const { kind, team } = leg.selection;
    if (kind === 'team') {
      if (!team) {
        ctx.addIssue({
          code: 'custom',
          message: 'team selection needs selection.team',
        });
      } else if (!leg.participants.includes(team)) {
        ctx.addIssue({
          code: 'custom',
          message: `selection.team "${team}" is not one of participants`,
        });
      }
    }
    if ((kind === 'over' || kind === 'under') !== (leg.market === 'total')) {
      ctx.addIssue({
        code: 'custom',
        message: 'over/under selections go with the total market only',
      });
    }
    if (kind === 'draw' && leg.market !== 'moneyline3way') {
      ctx.addIssue({
        code: 'custom',
        message: 'draw is only valid on moneyline3way',
      });
    }
    if (
      (leg.market === 'spread' || leg.market === 'total') &&
      leg.line == null
    ) {
      ctx.addIssue({ code: 'custom', message: `${leg.market} needs a line` });
    }
    if (
      (leg.market === 'moneyline' || leg.market === 'moneyline3way') &&
      leg.line != null
    ) {
      ctx.addIssue({ code: 'custom', message: `${leg.market} takes no line` });
    }
  });

export const betInputSchema = z
  .object({
    book: z.string().min(1),
    externalBetId: z.string().min(1).optional(),
    /** ISO 8601 with offset. */
    placedAt: z.iso.datetime({ offset: true }).optional(),
    /** Placed with the game in progress (entered odds aren't a pregame prior). */
    placedLive: z.boolean().default(false),
    stake: dollars,
    /** Price at placement, before any boost. */
    price: american,
    boostPct: z.number().positive().optional(),
    boostKind: z.enum(BOOST_KINDS).optional(),
    boostedPrice: american.optional(),
    /** Total payout (stake + profit) the book stated. */
    statedPayout: dollars.optional(),
    tokenInfo: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
    legs: z.array(legInputSchema).min(1),
  })
  .superRefine((bet, ctx) => {
    if ((bet.boostPct == null) !== (bet.boostKind == null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'boostPct and boostKind go together',
      });
    }
    if (bet.legs.length === 1 && bet.legs[0]!.price !== bet.price) {
      ctx.addIssue({
        code: 'custom',
        message: 'single bet: leg price must equal bet price',
      });
    }
  });

export type LegInput = z.infer<typeof legInputSchema>;
export type BetInput = z.input<typeof betInputSchema>;
export type ParsedBetInput = z.output<typeof betInputSchema>;
