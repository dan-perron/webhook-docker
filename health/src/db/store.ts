import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import type { z } from 'zod';
import {
  DEFAULT_LOOKBACK,
  type Lookback,
  comparisonStart,
  compareExperiment,
  experimentOverlaps,
  lookbackDays,
  windowStats,
} from '../domain/report.js';
import { dayInput, experimentInput, flareInput } from '../domain/schemas.js';
import { normalizeName, slugify } from '../domain/slug.js';
import type { DayLog, Experiment, Flare, Meals } from '../domain/types.js';
import { addDays, daysBetween, localDate } from '../util/date.js';

// Flares, day logs and experiments on the shared Mongo (database `health`).
// Mongo is standalone (no transactions): every write is one document.

/** A user-facing problem (unknown experiment, overlap...): shown as-is. */
export class StoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400
  ) {
    super(message);
  }
}

type In<T extends z.ZodType> = z.input<T>;

const defined = <T extends object>(o: T) =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null)
  ) as T;

const isRecord = (m: Meals | undefined): m is Record<string, string> =>
  !!m && !Array.isArray(m);

export class HealthStore {
  readonly flares: Collection<Flare>;
  readonly days: Collection<DayLog>;
  readonly experiments: Collection<Experiment>;
  readonly timeZone: string;
  readonly maxRangeDays: number;
  private readonly now: () => Date;

  constructor(
    db: Db,
    opts: { timeZone: string; maxRangeDays: number; now?: () => Date }
  ) {
    this.flares = db.collection('flares');
    this.days = db.collection('days');
    this.experiments = db.collection('experiments');
    this.timeZone = opts.timeZone;
    this.maxRangeDays = opts.maxRangeDays;
    this.now = opts.now ?? (() => new Date());
  }

  today = () => localDate(this.now(), this.timeZone);

  async ensureIndexes() {
    await this.flares.createIndex({ issue: 1, date: 1 });
    await this.experiments.createIndex({ issue: 1, start: 1 });
  }

  /** Save a flare; resending its id replaces it. */
  async upsertFlare(raw: In<typeof flareInput>): Promise<Flare> {
    const { id, ...input } = flareInput.parse(raw);
    const _id = id ?? randomUUID();
    const existing = await this.flares.findOne({ _id });
    const now = this.now();
    const flare = defined<Flare>({
      ...input,
      _id,
      date: input.date ?? this.today(),
      count: input.count ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await this.flares.replaceOne({ _id }, flare, { upsert: true });
    return flare;
  }

  /**
   * Update the day log for a date (one per date). Only the fields given
   * change; null clears one. Meals given per meal merge into the meals
   * already logged per meal; a list replaces them.
   */
  async upsertDay(raw: In<typeof dayInput>): Promise<DayLog> {
    const { date = this.today(), ...input } = dayInput.parse(raw);
    const existing = await this.days.findOne({ _id: date });
    const now = this.now();
    let meals = input.meals === undefined ? existing?.meals : input.meals;
    if (isRecord(input.meals ?? undefined) && isRecord(existing?.meals))
      meals = { ...existing.meals, ...input.meals };
    const day = defined<DayLog>({
      ...(existing ?? {}),
      ...input,
      meals: meals ?? undefined,
      _id: date,
      date,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as DayLog);
    await this.days.replaceOne({ _id: date }, day, { upsert: true });
    return day;
  }

  private async findExperiment(id?: string, name?: string) {
    if (id) return this.experiments.findOne({ _id: id });
    if (!name) return null;
    const key = normalizeName(name);
    const all = await this.experiments.find().toArray();
    return all.find((e) => normalizeName(e.name) === key) ?? null;
  }

  /**
   * Create, update or end an experiment (matched by id or exact name).
   * Experiments may not overlap in time: one change at a time.
   */
  async upsertExperiment(raw: In<typeof experimentInput>): Promise<Experiment> {
    const input = experimentInput.parse(raw);
    const existing = await this.findExperiment(input.id, input.name);
    if (input.id && !existing)
      throw new StoreError(`No experiment ${input.id}.`, 404);
    if (!existing && !(input.name && input.issue && input.rule))
      throw new StoreError(
        'A new experiment needs name, issue and rule (or give the id/name of an existing one).'
      );
    const now = this.now();
    // A name renames only an experiment matched by id.
    const name =
      (input.id ? input.name : undefined) ?? existing?.name ?? input.name!;
    let _id = existing?._id;
    if (!_id) {
      const base = slugify(name);
      _id = base;
      for (let n = 2; await this.experiments.findOne({ _id }); n++)
        _id = `${base}-${n}`;
    }
    const exp = defined<Experiment>({
      _id,
      name,
      issue: input.issue ?? existing!.issue,
      rule: input.rule ?? existing!.rule,
      start: input.start ?? existing?.start ?? this.today(),
      end: input.end === undefined ? existing?.end : (input.end ?? undefined),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (exp.end && exp.end < exp.start)
      throw new StoreError(`end ${exp.end} is before start ${exp.start}.`);
    const clash = (
      await this.experiments.find({ _id: { $ne: _id } }).toArray()
    ).find((o) => experimentOverlaps(o, exp.start, exp.end ?? '9999-12-31'));
    if (clash)
      throw new StoreError(
        `Overlaps experiment "${clash.name}" (${clash.start} to ${clash.end ?? 'ongoing'}); one experiment at a time: end it first (or change these dates).`
      );
    await this.experiments.replaceOne({ _id }, exp, { upsert: true });
    return exp;
  }

  /**
   * Flares for an issue from..to, each with the day logs from its lookback
   * window; and each of the issue's experiments overlapping the range, its
   * flare rate against the same-length period before it.
   */
  async report(
    issue: string,
    from?: string,
    to?: string,
    lookback: Lookback = DEFAULT_LOOKBACK
  ) {
    const today = this.today();
    to ??= today;
    from ??= addDays(to, -55);
    if (from > to) throw new StoreError(`from ${from} is after to ${to}.`);
    if (daysBetween(from, to) + 1 > this.maxRangeDays)
      throw new StoreError(
        `At most ${this.maxRangeDays} days per report; narrow from/to.`
      );
    if (lookback.minDays > lookback.maxDays)
      throw new StoreError('lookback minDays is after maxDays.');

    const allExps = await this.experiments.find().sort({ start: 1 }).toArray();
    const exps = allExps.filter(
      (e) => e.issue === issue && experimentOverlaps(e, from, to)
    );
    const earliest = comparisonStart(exps, today);
    const flareFrom = earliest && earliest < from ? earliest : from;
    const flareTo = to > today ? to : today;
    const flares = await this.flares
      .find({ issue, date: { $gte: flareFrom, $lte: flareTo } })
      .sort({ date: 1, createdAt: 1 })
      .toArray();
    const inRange = flares.filter((f) => f.date >= from && f.date <= to);
    const days = await this.days
      .find({
        date: {
          $gte: addDays(from, -lookback.maxDays),
          $lte: addDays(to, -lookback.minDays),
        },
      })
      .toArray();
    const byDate = new Map(days.map((d) => [d.date, d]));
    const activeOn = (date: string) =>
      allExps.find((e) => experimentOverlaps(e, date, date))?.name ?? null;

    return {
      issue,
      from,
      to,
      lookback,
      summary: windowStats(from, to, inRange),
      flares: inRange.map((f) => ({
        ...f,
        experiment: activeOn(f.date),
        lookback: lookbackDays(f.date, byDate, lookback),
      })),
      experiments: exps.map((e) =>
        compareExperiment(e, allExps, flares, today)
      ),
    };
  }

  /** The day logs for the lookback window before a date. */
  async lookback(date: string, lookback: Lookback = DEFAULT_LOOKBACK) {
    const days = await this.days
      .find({
        date: {
          $gte: addDays(date, -lookback.maxDays),
          $lte: addDays(date, -lookback.minDays),
        },
      })
      .toArray();
    return lookbackDays(date, new Map(days.map((d) => [d.date, d])), lookback);
  }

  async activeExperiment(date = this.today()) {
    return (
      (await this.experiments.find().toArray()).find((e) =>
        experimentOverlaps(e, date, date)
      ) ?? null
    );
  }
}
