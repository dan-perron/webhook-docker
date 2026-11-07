/** Meals as Dan reports them: one entry per meal, or keyed by meal. */
export type Meals = string[] | Record<string, string>;

/** One occurrence of a recurring issue (e.g. two canker sores on a day). */
export interface Flare {
  _id: string;
  date: string;
  issue: string;
  count: number;
  location?: string;
  severity?: number;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Possible triggers for one date; `_id` is the date. */
export interface DayLog {
  _id: string;
  date: string;
  sleepHours?: number;
  alcohol?: boolean;
  meals?: Meals;
  /** Restaurant, takeout or store-prepared food that day. */
  preparedFood?: boolean;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One change tried against an issue over a date range (end inclusive). */
export interface Experiment {
  _id: string;
  name: string;
  issue: string;
  /** One sentence, e.g. "no Just Salad". */
  rule: string;
  start: string;
  end?: string;
  createdAt: Date;
  updatedAt: Date;
}
