import { formatDateGds } from '#/config/nunjucks/filters/format-date.js'

/**
 * SLA-clock duration ↔ deadline date (RA-572 follow-up).
 *
 * Every SLA value on a work item's audit entries — `beforeTargetDuration`,
 * `afterTargetDuration`, `additionalDuration` — is an ISO-8601 duration in
 * the form .NET's `XmlConvert.ToString(TimeSpan)` writes. This module is the
 * single place those are understood, so the audit log renders the deadline
 * DATES a caseworker can act on rather than the raw `P114D` on the wire.
 *
 * The parsing is deliberately strict. A `TimeSpan` has no calendar
 * component, so its serialised form can only ever carry days, hours,
 * minutes and seconds: a duration bearing a year or month designator is
 * REJECTED rather than guessed at, because those are not fixed-length and
 * we would be inventing a date. Callers get `null` for anything they cannot
 * trust and are expected to omit the row entirely — a missing row is
 * always better than a wrong deadline.
 */

const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000
const MS_PER_MINUTE = 60_000
const MS_PER_SECOND = 1000

/**
 * The gross shape of a duration: an optional sign, the mandatory `P`, then
 * the date and (optional) time halves split on `T`. Deliberately permissive
 * — it locates the two halves without validating either, leaving each to
 * its own small pattern below. One pattern doing both jobs is what made
 * this unreadable.
 *
 * The time half is `.+` rather than `.*` on purpose: ISO 8601 requires the
 * `T` to introduce at least one component, so a trailing `T` (`P84DT`) is
 * malformed and must be refused rather than quietly read as 84 days.
 */
const DURATION_SHAPE = /^(-)?P([^T]*)(?:T(.+))?$/

/**
 * The date half, which for a `TimeSpan` may only be a day count (or
 * nothing at all). `P2M`/`P1Y` fail here — that is where a calendar
 * component is refused.
 */
const DAY_COMPONENT = /^(?:(\d+)D)?$/

/** The time half: hours, minutes and (possibly fractional) seconds. */
const TIME_COMPONENTS = /^(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/

/**
 * Sum the captured day/hour/minute/second components into milliseconds.
 * Returns `null` when the duration carried no component at all (`P`, `PT`)
 * or when either half is malformed — a zero-length duration is a
 * meaningless deadline offset, not a valid zero.
 */
function durationBodyToMs(datePart, timePart) {
  const dayMatch = DAY_COMPONENT.exec(datePart)
  const timeMatch = TIME_COMPONENTS.exec(timePart ?? '')
  if (!dayMatch || !timeMatch) {
    return null
  }
  const components = [dayMatch[1], timeMatch[1], timeMatch[2], timeMatch[3]]
  if (components.every((component) => component === undefined)) {
    return null
  }
  const [days, hours, minutes, seconds] = components
  return (
    Number(days ?? 0) * MS_PER_DAY +
    Number(hours ?? 0) * MS_PER_HOUR +
    Number(minutes ?? 0) * MS_PER_MINUTE +
    Number(seconds ?? 0) * MS_PER_SECOND
  )
}

/**
 * Milliseconds represented by an XSD / ISO-8601 duration, or `null` for an
 * absent, malformed, calendar-bearing or componentless one. See the module
 * comment for why the strictness matters.
 */
export function parseSlaDurationMs(value) {
  if (typeof value !== 'string') {
    return null
  }
  const match = DURATION_SHAPE.exec(value.trim())
  if (!match) {
    return null
  }
  const [, sign, datePart, timePart] = match
  const ms = durationBodyToMs(datePart, timePart)
  if (ms === null) {
    return null
  }
  return sign ? -ms : ms
}

/**
 * Resolve one half of an SLA-clock snapshot (`startedAt` + `targetDuration`)
 * into the deadline DATE it represents, formatted for display. This is the
 * same sum the backend uses to project `slaDueDate`, so the audit entry and
 * the work item agree. Returns `null` when either half is missing or
 * unparseable so the caller can omit the row entirely.
 */
export function slaDeadlineDisplay(startedAt, targetDuration) {
  if (!startedAt) {
    return null
  }
  const started = new Date(startedAt)
  const durationMs = parseSlaDurationMs(targetDuration)
  if (Number.isNaN(started.getTime()) || durationMs === null) {
    return null
  }
  return formatDateGds(new Date(started.getTime() + durationMs))
}
