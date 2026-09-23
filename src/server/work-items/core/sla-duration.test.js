import {
  parseSlaDurationMs,
  slaDeadlineDisplay
} from '#/server/work-items/core/sla-duration.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

describe('parseSlaDurationMs', () => {
  test.each([
    ['P84D', 84 * DAY_MS],
    ['P1D', DAY_MS],
    ['PT12H', 12 * HOUR_MS],
    ['PT30M', 1_800_000],
    ['PT45S', 45_000],
    ['PT1.5S', 1500],
    ['P83DT23H59M30S', 83 * DAY_MS + 23 * HOUR_MS + 59 * 60_000 + 30_000],
    ['-P1D', -DAY_MS],
    ['  P7D  ', 7 * DAY_MS]
  ])('parses %s', (value, expected) => {
    expect(parseSlaDurationMs(value)).toBe(expected)
  })

  // A TimeSpan has no calendar component, so a year or month designator can
  // only mean the value did not come from where we think it did. Guessing a
  // length for it would put a wrong deadline in front of a caseworker, so
  // these are refused rather than approximated.
  test.each(['P1Y', 'P2M', 'P1Y6M', 'P1YT1H'])(
    'refuses the calendar-bearing duration %s rather than guessing its length',
    (value) => {
      expect(parseSlaDurationMs(value)).toBeNull()
    }
  )

  // A componentless duration is a meaningless deadline offset, not a zero.
  test.each(['P', 'PT', '-P'])(
    'rejects the componentless duration %s',
    (value) => {
      expect(parseSlaDurationMs(value)).toBeNull()
    }
  )

  test.each([
    '84 days',
    '84D',
    'P84',
    'PD',
    'P84DT',
    'P1DT1HT2H',
    'PT1S1H',
    ''
  ])('rejects the malformed duration %s', (value) => {
    expect(parseSlaDurationMs(value)).toBeNull()
  })

  test.each([
    ['a number', 84],
    ['null', null],
    ['undefined', undefined],
    ['an object', { days: 84 }]
  ])('rejects %s rather than coercing it', (_label, value) => {
    expect(parseSlaDurationMs(value)).toBeNull()
  })
})

describe('slaDeadlineDisplay', () => {
  test('resolves a start plus a target duration into the deadline date', () => {
    expect(slaDeadlineDisplay('2026-04-27T10:00:00.0000000Z', 'P84D')).toBe(
      '20 July 2026'
    )
  })

  test('carries a time-of-day component into the same resulting date', () => {
    expect(slaDeadlineDisplay('2026-04-27T10:00:00Z', 'P83DT23H59M30S')).toBe(
      '20 July 2026'
    )
  })

  test('applies a negative duration backwards from the start', () => {
    expect(slaDeadlineDisplay('2026-04-27T10:00:00Z', '-P1D')).toBe(
      '26 April 2026'
    )
  })

  test.each([
    ['an absent start', undefined, 'P84D'],
    ['an empty start', '', 'P84D'],
    ['an unparseable start', 'not-a-date', 'P84D'],
    ['an absent duration', '2026-04-27T10:00:00Z', undefined],
    ['a malformed duration', '2026-04-27T10:00:00Z', '84 days'],
    ['a calendar-bearing duration', '2026-04-27T10:00:00Z', 'P2M'],
    ['a componentless duration', '2026-04-27T10:00:00Z', 'PT']
  ])('returns null for %s so the caller omits the row', (_l, start, value) => {
    expect(slaDeadlineDisplay(start, value)).toBeNull()
  })
})
