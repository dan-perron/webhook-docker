import type { BetInput, LegInput } from '../domain/betInput.js';

// Dan's open FanDuel bets as of 2026-10-03. Legs are entered unmatched; the
// event matcher resolves event ids and home/away sides.

const D3 = '2026-10-03';
const D4 = '2026-10-04';

const mlbMl = (
  team: string,
  opponent: string,
  label: string,
  price: number
): LegInput => ({
  sport: 'mlb',
  eventDate: D3,
  participants: [team, opponent],
  eventLabel: label,
  market: 'moneyline',
  selection: { kind: 'team', team },
  price,
});

const ufcMl = (fighter: string, opponent: string, price: number): LegInput => ({
  sport: 'mma',
  eventDate: D3,
  participants: [fighter, opponent],
  eventLabel: `${fighter} v ${opponent}`,
  market: 'moneyline',
  selection: { kind: 'team', team: fighter },
  price,
});

const cfbSpread = (
  team: string,
  opponent: string,
  label: string,
  line: number,
  price: number
): LegInput => ({
  sport: 'ncaaf',
  eventDate: D3,
  participants: [team, opponent],
  eventLabel: label,
  market: 'spread',
  selection: { kind: 'team', team },
  line,
  price,
});

const cfbTotal = (
  a: string,
  b: string,
  kind: 'over' | 'under',
  line: number,
  price: number
): LegInput => ({
  sport: 'ncaaf',
  eventDate: D3,
  participants: [a, b],
  eventLabel: `${a}/${b}`,
  market: 'total',
  selection: { kind },
  line,
  price,
});

export const seedBets: BetInput[] = [
  {
    book: 'FanDuel',
    stake: 10,
    price: 128,
    boostPct: 25,
    boostKind: 'profit_boost',
    boostedPrice: 160,
    statedPayout: 26.0,
    notes: 'ALDS Game 1',
    legs: [
      mlbMl(
        'Chicago White Sox',
        'Cleveland Guardians',
        'CWS @ CLE (ALDS G1)',
        128
      ),
    ],
  },
  {
    book: 'FanDuel',
    placedAt: '2026-10-03T13:16:00-05:00',
    placedLive: true,
    stake: 10,
    price: 200,
    boostPct: 50,
    boostKind: 'live_boost',
    boostedPrice: 300,
    statedPayout: 40.0,
    notes: 'ALDS Game 1, live',
    legs: [
      mlbMl(
        'Cleveland Guardians',
        'Chicago White Sox',
        'CWS @ CLE (ALDS G1)',
        200
      ),
    ],
  },
  {
    book: 'FanDuel',
    stake: 10,
    price: 785,
    boostPct: 30,
    boostKind: 'profit_boost',
    boostedPrice: 1019,
    statedPayout: 111.99,
    legs: [
      mlbMl('Atlanta Braves', 'Los Angeles Dodgers', 'ATL @ LAD', 180),
      mlbMl('New York Yankees', 'Tampa Bay Rays', 'NYY @ TB', 114),
      mlbMl('Milwaukee Brewers', 'San Diego Padres', 'SD @ MIL', -210),
    ],
  },
  {
    book: 'FanDuel',
    stake: 10,
    price: 188,
    boostPct: 30,
    boostKind: 'profit_boost',
    boostedPrice: 246,
    statedPayout: 34.6,
    legs: [mlbMl('San Diego Padres', 'Milwaukee Brewers', 'SD @ MIL', 188)],
  },
  {
    book: 'FanDuel',
    stake: 10,
    price: 541,
    boostPct: 30,
    boostKind: 'profit_boost',
    boostedPrice: 703,
    statedPayout: 80.32,
    notes: 'UFC parlay',
    legs: [
      ufcMl('Roman Kopylov', 'Ateba Gautier', 216),
      ufcMl('Esteban Ribovics', 'King Green', -166),
      ufcMl('Natalia Silva', 'Wang Cong', -173),
    ],
  },
  {
    book: 'FanDuel',
    stake: 10,
    price: 184,
    boostPct: 30,
    boostKind: 'profit_boost',
    boostedPrice: 240,
    statedPayout: 34.0,
    legs: [
      {
        sport: 'ncaaf',
        eventDate: D3,
        participants: ['Minnesota', 'Michigan'],
        eventLabel: 'Michigan vs Minnesota',
        market: 'moneyline',
        selection: { kind: 'team', team: 'Minnesota' },
        price: 184,
      },
    ],
  },
  {
    book: 'FanDuel',
    stake: 10,
    price: -104,
    boostPct: 50,
    boostKind: 'profit_boost',
    boostedPrice: 145,
    statedPayout: 24.5,
    legs: [
      cfbSpread(
        'Mississippi State',
        'Alabama',
        'Alabama vs Mississippi State',
        5.5,
        -104
      ),
    ],
  },
  {
    book: 'FanDuel',
    stake: 5,
    price: -190,
    statedPayout: 7.63,
    tokenInfo: 'Touchdown Tally token used',
    legs: [
      {
        sport: 'nfl',
        eventDate: D4,
        participants: ['Los Angeles Rams', 'Philadelphia Eagles'],
        eventLabel: 'LAR @ PHI',
        market: 'moneyline',
        selection: { kind: 'team', team: 'Los Angeles Rams' },
        price: -190,
      },
    ],
  },
  {
    book: 'FanDuel',
    stake: 10,
    price: 350,
    boostPct: 30,
    boostKind: 'profit_boost',
    boostedPrice: 455,
    statedPayout: 55.5,
    notes: 'Kickoff 1:45 PM CT',
    legs: [
      {
        sport: 'soccer',
        eventDate: D4,
        participants: ['Portugal', 'Norway'],
        eventLabel: 'Portugal v Norway',
        market: 'moneyline3way',
        selection: { kind: 'draw' },
        price: 350,
      },
    ],
  },
  {
    book: 'FanDuel',
    stake: 10,
    price: 122832,
    boostPct: 105,
    boostKind: 'boost_builder',
    boostedPrice: 251878,
    statedPayout: 25197.81,
    notes: '11-leg NCAAF parlay',
    legs: [
      cfbTotal('Michigan', 'Minnesota', 'over', 41.5, 102),
      cfbTotal('Alabama', 'Mississippi State', 'under', 62.5, 103),
      cfbSpread('SMU', 'Boston College', 'SMU vs Boston College', -21.5, 107),
      cfbSpread('UCF', 'Houston', 'UCF @ Houston', 10.5, 105),
      cfbSpread('Air Force', 'Navy', 'Air Force vs Navy', -2.5, -107),
      cfbTotal('Stanford', 'Wake Forest', 'under', 54.5, 105),
      cfbTotal('Syracuse', 'UConn', 'over', 51.5, 105),
      cfbSpread(
        'Iowa State',
        'West Virginia',
        'Iowa State vs West Virginia',
        -2.5,
        -108
      ),
      cfbSpread(
        'Notre Dame',
        'North Carolina',
        'Notre Dame @ North Carolina',
        -21.5,
        113
      ),
      cfbSpread(
        'Wisconsin',
        'Michigan State',
        'Wisconsin vs Michigan State',
        -8.5,
        103
      ),
      cfbTotal('Vanderbilt', 'Georgia', 'under', 50.5, 108),
    ],
  },
];
