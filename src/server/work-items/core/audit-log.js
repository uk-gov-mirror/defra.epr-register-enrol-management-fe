import { formatDateTimeGds } from '#/config/nunjucks/filters/format-date.js'
import { nationLabel } from '#/server/work-items/core/nations.js'
import { slaDeadlineDisplay } from '#/server/work-items/core/sla-duration.js'

/**
 * Audit log helpers (RA-97).
 *
 * The backend appends one `auditLog` entry to a work item for every
 * successful state-changing engine call (action
 * application, assignment / unassignment, note added). Entries arrive
 * already sorted reverse-chronologically (newest-first, RA-568). The
 * detail template renders them as a top-to-bottom timeline; this helper
 * produces a short human-readable `summary` per entry from the structured
 * `details` dictionary so the template can stay declarative.
 */

/**
 * Decorate the raw audit log from a backend `WorkItemResponse` with a
 * `summary` string suitable for direct rendering. Returns the entries in
 * the same order the backend projected them (newest-first, RA-568).
 *
 * The optional `payload` is the current work item payload; when supplied
 * it is surfaced as a `Payload` row on the `work-item-submitted` entry
 * so the original submission body lives with its audit record rather
 * than as a stand-alone panel on the detail page (RA-186).
 *
 * The optional `workItemSnapshot` adds a consistent set of work-item
 * context rows (Org ID, Type, State, Submitted at, Submitted by,
 * Last modified, Assigned to) to the disclosure of every audit entry
 * EXCEPT `routed-to-nation`/`nation-corrected` — see
 * `NO_SNAPSHOT_CONTEXT_ACTIONS`.
 *
 * The "State" row is special: it is per-entry, resolved from each entry's
 * OWN `stateId` (the work-item state as-of that event — epr-rr9s) via the
 * optional `resolveStateDisplayName(stateId)` callback, NOT from the live
 * work-item state on the snapshot. Passing the live state onto every entry
 * was the historical-state bug this contract fixes.
 */
export function decorateAuditLog(
  entries,
  { payload, workItemSnapshot, resolveStateDisplayName } = {}
) {
  if (!Array.isArray(entries)) {
    return []
  }
  return entries.map((entry) => ({
    ...entry,
    actionDisplayName: actionDisplayNameFor(entry),
    summary: summariseAuditEntry(entry),
    isFailure: isFailureAuditEntry(entry),
    detailRows: [
      ...detailRowsForAuditEntry(entry, { payload }),
      ...buildSnapshotRows(workItemSnapshot, entry, resolveStateDisplayName)
    ]
  }))
}

/**
 * Audit actions whose own event-specific detail rows already state the
 * work item's resulting (as-of) state. For these we suppress the
 * context-block "State" row so the same value is not shown twice on the
 * one entry:
 *
 *   - `work-item-submitted`  — Initial state (`details.stateId`)
 *   - `action-applied`       — Previous / New state
 *   - `status-push-sent` / `status-push-skipped` / `status-push-failed`
 *     — Previous / New state, via `statusPushDetailRows`
 *
 * The status-push actions matter especially: their `New state` row reads
 * `details.toStateDisplayName ?? details.toStateId`, the vocabulary the
 * push hook recorded for the Registration & Accreditation service, while
 * the context row would resolve `entry.stateId` through the Case
 * Management service's `type.states` display names. Left unsuppressed, one
 * entry could show `New state: <Registration & Accreditation service
 * label>` alongside `State: <Case Management service label>` for the same
 * state.
 *
 * Every other action — assignment, notes, notifications, and the retired
 * `task-completed` / `task-status-changed` entries — carries no state in
 * its own rows, so it DOES get the context-block State row: that is where
 * a caseworker learns which state the item was in when the event happened.
 * The two exceptions to THAT are `routed-to-nation`/`nation-corrected`,
 * which get no context-block rows at all — see `NO_SNAPSHOT_CONTEXT_ACTIONS`
 * below, a stronger exclusion than this set.
 *
 * RA-410 removed the task framework and purged the `task-completed` /
 * `task-status-changed` cases from `detailRowsForAuditEntry`, so those
 * actions no longer render a State row of their own. They are therefore
 * NOT in this set: a historical task entry that carries a per-entry
 * `stateId` now surfaces it through the context-block row like any other
 * auxiliary action (and old task entries with no `stateId` simply omit
 * it), rather than being silently suppressed.
 */
const ACTION_WORK_ITEM_SUBMITTED = 'work-item-submitted'
const ACTION_APPLIED = 'action-applied'
const ACTION_ASSIGNED = 'assigned'
const ACTION_UNASSIGNED = 'unassigned'
const ACTION_NOTE_ADDED = 'note-added'
const ACTION_NOTIFICATION_SENT = 'notification-sent'
const ACTION_NOTIFICATION_SKIPPED = 'notification-skipped'
const ACTION_NOTIFICATION_FAILED = 'notification-failed'
const ACTION_STATUS_PUSH_SENT = 'status-push-sent'
const ACTION_STATUS_PUSH_SKIPPED = 'status-push-skipped'
const ACTION_STATUS_PUSH_FAILED = 'status-push-failed'
const ACTION_ROUTED_TO_NATION = 'routed-to-nation'
const ACTION_NATION_CORRECTED = 'nation-corrected'
// RA-291: the query-detail entry ReAccreditationQueryService appends after a
// `query-during-*` transition, carrying the selected sections and the
// (RA-534: optional) free-text reason in its `details`.
const ACTION_APPLICATION_QUERIED = 'application-queried'
// RA-572 follow-up: the entry `SlaService.ExtendAsync` appends when a
// regulator changes the determination deadline, carrying the mandatory
// free-text reason plus before/after SLA-clock snapshots in its `details`.
// NOTE the past tense: the backend action id is `sla-extended`, which
// deliberately differs from the `sla-extend` transition id the engine
// projects onto the detail page.
const ACTION_SLA_EXTENDED = 'sla-extended'

/**
 * Human-readable labels for the query `details.sections` values — the same
 * closed set the query form renders as checkboxes (RA-291). Kept local, like
 * `DERIVED_FROM_DISPLAY_NAMES` above, so `core/` does not import from the
 * `routes/` layer; an unknown value renders verbatim rather than being
 * dropped.
 */
const QUERY_SECTION_DISPLAY_NAMES = {
  'authority-to-issue': 'Authority to issue',
  'business-plan': 'Business plan',
  'prn-tonnage': 'PRN tonnage',
  'sampling-and-inspection-plan': 'Sampling and inspection plan',
  'broadly-equivalent-standards': 'Broadly equivalent standards (BES)',
  'overseas-reprocessing-sites': 'Overseas reprocessing sites (ORS)'
}

/**
 * Parse `details.sections` — stored by the backend as a comma-joined string
 * (`"authority-to-issue,business-plan"`) — into a list of display names.
 * Tolerates an already-split array and stray whitespace.
 */
function queriedSectionLabels(sections) {
  let raw
  if (Array.isArray(sections)) {
    raw = sections
  } else if (typeof sections === 'string') {
    raw = sections.split(',')
  } else {
    raw = []
  }
  return raw
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => QUERY_SECTION_DISPLAY_NAMES[value] ?? value)
}

/**
 * Human-readable form of `routed-to-nation`'s `derivedFrom` value.
 *
 * RA-526: `submitted` is the current, correct path — ReAccreditationNationRoutingHook
 * trusts the nation the caller already submitted, which the operator-facing
 * backend derives from the REGISTRATION's own ReEx regulator
 * (`RegulatorNationMapper`), not from any address. `site-address` is the
 * pre-RA-526 value every historical entry still carries verbatim (audit
 * history is never rewritten) — it named a postcode-based derivation that
 * never actually worked on real submissions (see RA-526), so it is labelled
 * as legacy here rather than describing a live behaviour.
 */
const DERIVED_FROM_DISPLAY_NAMES = {
  submitted: "Registration's regulator",
  'default-england': 'No nation provided (defaulted to England)',
  'site-address': 'Site address'
}

function derivedFromDisplayName(derivedFrom) {
  return DERIVED_FROM_DISPLAY_NAMES[derivedFrom] ?? derivedFrom
}

const STATE_BEARING_ACTIONS = new Set([
  ACTION_WORK_ITEM_SUBMITTED,
  ACTION_APPLIED,
  ACTION_STATUS_PUSH_SENT,
  ACTION_STATUS_PUSH_SKIPPED,
  ACTION_STATUS_PUSH_FAILED
])

/**
 * Audit actions that get NO context-block rows at all (Org ID, Type, State,
 * Submitted at, Submitted by, Last modified, Assigned to) — unlike every
 * other action, for which that context is exactly what a caseworker needs
 * alongside the entry. RA-526's routing/correction entries are a
 * system-derived side effect of submission rather than a workflow action
 * against the item, so none of that context — including who the item
 * happens to be assigned to — has anything to do with why a nation was
 * chosen or corrected.
 */
const NO_SNAPSHOT_CONTEXT_ACTIONS = new Set([
  ACTION_ROUTED_TO_NATION,
  ACTION_NATION_CORRECTED
])

/**
 * Build the context-block "State" row for a single audit entry from that
 * entry's OWN `stateId` (epr-rr9s): the work-item state as-of the event,
 * resolved to a display name via the SAME state-definition machinery the
 * controller uses for the live state. Returns null when the row should be
 * omitted:
 *   - the entry already conveys its resulting state in its own rows (see
 *     STATE_BEARING_ACTIONS), or
 *   - the entry has no `stateId` (older documents predating the backend
 *     change). We NEVER fall back to the current work-item state here —
 *     that is exactly the bug this fixes.
 */
function buildEntryStateRow(entry, resolveStateDisplayName) {
  if (entry == null || typeof entry !== 'object') {
    return null
  }
  if (STATE_BEARING_ACTIONS.has(entry.action)) {
    return null
  }
  const stateId = entry.stateId
  if (stateId == null || stateId === '') {
    return null
  }
  const value =
    typeof resolveStateDisplayName === 'function'
      ? resolveStateDisplayName(stateId)
      : stateId
  if (value == null || value === '') {
    return null
  }
  return { key: 'State', value }
}

/**
 * Build the work-item context rows that appear in the "Show details"
 * disclosure of an audit entry. Returns an empty array when no snapshot is
 * supplied so callers that don't need this context are unaffected. Every
 * row except "State" is the same across entries; the "State" row is
 * per-entry (see `buildEntryStateRow`).
 */
function buildSnapshotRows(snapshot, entry, resolveStateDisplayName) {
  if (snapshot == null || typeof snapshot !== 'object') {
    return []
  }
  // RA-526: routing/correction entries are a system-derived side effect of
  // submission, not a caseworker action against the item's own workflow —
  // none of this context block (including who the item happens to be
  // assigned to) has anything to do with why a nation was chosen or
  // corrected, so it is noise here rather than the useful "what state was
  // this in" context it is on every other action.
  if (NO_SNAPSHOT_CONTEXT_ACTIONS.has(entry?.action)) {
    return []
  }
  // Each row is its own pure helper (returning null when its value is
  // absent) rather than a chain of `if`s pushing onto a shared array —
  // keeps this function's own complexity low regardless of how many
  // optional rows the context block grows to.
  return [
    orgIdRow(snapshot),
    typeRow(snapshot),
    buildEntryStateRow(entry, resolveStateDisplayName),
    submittedAtRow(snapshot),
    submittedByRow(snapshot),
    lastModifiedRow(snapshot),
    assignedToRow(snapshot)
  ].filter(Boolean)
}

const orgIdRow = (snapshot) =>
  snapshot.orgId ? { key: 'Org ID', value: snapshot.orgId } : null

const typeRow = (snapshot) =>
  snapshot.typeDisplayName
    ? { key: 'Type', value: snapshot.typeDisplayName }
    : null

const submittedAtRow = (snapshot) => {
  const submittedAt = formatDateTimeGds(snapshot.submittedAt)
  return submittedAt ? { key: 'Submitted at', value: submittedAt } : null
}

const submittedByRow = (snapshot) =>
  snapshot.submittedBy
    ? { key: 'Submitted by', value: snapshot.submittedBy }
    : null

const lastModifiedRow = (snapshot) => {
  const lastModified = formatDateTimeGds(snapshot.lastModifiedAt)
  return lastModified ? { key: 'Last modified', value: lastModified } : null
}

// Unlike the rows above, this one is never absent — an unassigned item
// still gets an explicit "Unassigned" value rather than no row at all.
const assignedToRow = (snapshot) => ({
  key: 'Assigned to',
  value: snapshot.assignedToName ?? 'Unassigned'
})

/**
 * Humanised label for the audit timeline. Falls back to a per-action
 * lookup when the backend hasn't supplied an `actionDisplayName` (e.g.
 * for newer audit actions added before the backend humaniser caught up).
 */
const ACTION_DISPLAY_NAMES = {
  [ACTION_WORK_ITEM_SUBMITTED]: 'Work item submitted',
  [ACTION_APPLIED]: 'Action applied',
  [ACTION_ASSIGNED]: 'Assigned',
  [ACTION_UNASSIGNED]: 'Unassigned',
  [ACTION_NOTE_ADDED]: 'Note added',
  [ACTION_NOTIFICATION_SENT]: 'Notification sent',
  [ACTION_NOTIFICATION_SKIPPED]: 'Notification not sent',
  [ACTION_NOTIFICATION_FAILED]: 'Notification failed',
  [ACTION_STATUS_PUSH_SENT]:
    'Status sent to the Registration & Accreditation service',
  [ACTION_STATUS_PUSH_SKIPPED]:
    'Status not sent to the Registration & Accreditation service (disabled)',
  [ACTION_STATUS_PUSH_FAILED]:
    'Status failed to send to the Registration & Accreditation service',
  [ACTION_ROUTED_TO_NATION]: 'Routed to nation',
  [ACTION_NATION_CORRECTED]: 'Nation corrected',
  [ACTION_APPLICATION_QUERIED]: 'Application queried'
}

/**
 * Audit actions that record a failed regulator notification or a failed
 * Registration & Accreditation service status push. These render in a visually distinct (error-styled) way
 * on the audit-log page (RA-234, RA-368) so failures are obviously
 * displayed rather than buried as another grey timeline row.
 */
const FAILURE_ACTIONS = new Set([
  ACTION_NOTIFICATION_FAILED,
  ACTION_STATUS_PUSH_FAILED
])

function isFailureAuditEntry(entry) {
  if (entry == null || typeof entry !== 'object') {
    return false
  }
  return FAILURE_ACTIONS.has(entry.action)
}

/**
 * RA-211: whether a work item has an unresolved notification failure worth
 * surfacing as a banner. A `notification-failed` entry is "unresolved" when
 * no `notification-sent` entry for the SAME template has a later
 * `createdAt` timestamp anywhere in the audit log (compared by timestamp,
 * not array position — the array itself is newest-first, RA-568) — a
 * later, unrelated notification
 * succeeding (e.g. DulyMade) must not hide an earlier, still-unresolved
 * failure of a different one (e.g. Queried). When either entry lacks a
 * `details.templateKey` (older data), falls back to treating any later
 * success as resolving it, so pre-RA-211 audit entries degrade safely
 * rather than showing a false banner forever.
 *
 * The backend only ever writes `notification-failed` after its own
 * 3-attempt retry pipeline is exhausted (see GovukNotifyClient), so there
 * is no separate "still retrying" audit state to filter out here — a
 * still-in-flight send simply hasn't written any entry yet.
 */
export function notificationFailureDetected(auditLog) {
  if (!Array.isArray(auditLog)) {
    return false
  }
  const failed = auditLog.filter(
    (entry) => entry?.action === ACTION_NOTIFICATION_FAILED
  )
  const sent = auditLog.filter(
    (entry) => entry?.action === ACTION_NOTIFICATION_SENT
  )
  return failed.some((failure) => {
    const failureTemplate = failure?.details?.templateKey
    return !sent.some((success) => {
      if (!(new Date(success.createdAt) > new Date(failure.createdAt))) {
        return false
      }
      const successTemplate = success?.details?.templateKey
      if (failureTemplate && successTemplate) {
        return successTemplate === failureTemplate
      }
      return true
    })
  })
}

function actionDisplayNameFor(entry) {
  if (entry == null || typeof entry !== 'object') {
    return ''
  }
  if (
    typeof entry.actionDisplayName === 'string' &&
    entry.actionDisplayName.trim() !== ''
  ) {
    return entry.actionDisplayName
  }
  return ACTION_DISPLAY_NAMES[entry.action] ?? entry.action ?? ''
}

/**
 * Build a one-line summary of an audit entry from its `action` and
 * `details`. Falls back to an empty string when there is nothing useful to
 * add (the template already shows the action display name).
 */
export function summariseAuditEntry(entry) {
  if (entry == null || typeof entry !== 'object') {
    return ''
  }
  const details = entry.details ?? {}
  switch (entry.action) {
    case ACTION_APPLIED: {
      const action = details.actionDisplayName ?? details.actionId ?? ''
      const from = details.fromStateId
      const to = details.toStateId
      if (from && to) {
        return action ? `${action} (${from} → ${to})` : `${from} → ${to}`
      }
      return action
    }
    case ACTION_ASSIGNED: {
      const to = details.assigneeName ?? details.assigneeId ?? 'unknown user'
      const from = details.previousAssigneeName ?? details.previousAssigneeId
      return from ? `${from} → ${to}` : to
    }
    case ACTION_UNASSIGNED: {
      const from = details.previousAssigneeName ?? details.previousAssigneeId
      return from ? `was ${from}` : ''
    }
    case ACTION_NOTE_ADDED:
      return ''
    case ACTION_APPLICATION_QUERIED:
      // The areas queried are the at-a-glance summary; the (optional) reason
      // is shown in full in the disclosure rather than truncated here.
      return queriedSectionLabels(details.sections).join(', ')
    case ACTION_NOTIFICATION_SENT:
      return details.recipient ?? ''
    case ACTION_NOTIFICATION_SKIPPED:
      return details.reason ?? ''
    case ACTION_NOTIFICATION_FAILED:
      return details.errorMessage ?? ''
    case ACTION_STATUS_PUSH_SENT:
      return details.toStateDisplayName ?? details.toStateId ?? ''
    case ACTION_STATUS_PUSH_SKIPPED:
      return details.reason ?? ''
    case ACTION_STATUS_PUSH_FAILED:
      return details.errorMessage ?? ''
    default:
      return ''
  }
}

/**
 * Project the structured `details` of an audit entry into a list of
 * `{ key, value, multiline? }` rows suitable for rendering inside a
 * disclosure (`<details>` / `govuk-details`). Returns an empty array when
 * the entry has nothing extra worth surfacing — the template should then
 * skip the disclosure entirely.
 *
 * Set `multiline: true` to tell the template to preserve newlines in the
 * value (paragraph-per-line). Set `preformatted: true` to render the
 * value inside a monospace `<pre>` block, preserving all whitespace
 * verbatim (used for the JSON payload row). Otherwise the value renders
 * inline.
 */
export function detailRowsForAuditEntry(entry, { payload } = {}) {
  if (entry == null || typeof entry !== 'object') {
    return []
  }
  const details = entry.details ?? {}
  switch (entry.action) {
    case ACTION_WORK_ITEM_SUBMITTED: {
      const rows = []
      if (details.typeId) {
        rows.push({ key: 'Type', value: details.typeId })
      }
      if (details.stateId) {
        rows.push({ key: 'Initial state', value: details.stateId })
      }
      const actor = entry.createdByName ?? entry.createdBy
      if (actor) {
        rows.push({ key: 'Submitted by', value: actor })
      }
      const payloadJson = formatPayloadForAudit(payload)
      if (payloadJson !== '') {
        rows.push({ key: 'Payload', value: payloadJson, preformatted: true })
      }
      return rows
    }
    case ACTION_APPLIED: {
      const rows = []
      const action = details.actionDisplayName ?? details.actionId
      if (action) {
        rows.push({ key: 'Action', value: action })
      }
      if (details.fromStateId) {
        rows.push({ key: 'Previous state', value: details.fromStateId })
      }
      if (details.toStateId) {
        rows.push({ key: 'New state', value: details.toStateId })
      }
      const actor = entry.createdByName ?? entry.createdBy
      if (actor) {
        rows.push({ key: 'Applied by', value: actor })
      }
      return rows
    }
    case ACTION_ASSIGNED: {
      const rows = []
      const previous =
        details.previousAssigneeName ?? details.previousAssigneeId
      const next = details.assigneeName ?? details.assigneeId
      rows.push({ key: 'Previously assigned to', value: previous ?? 'Nobody' })
      if (next) {
        rows.push({ key: 'Now assigned to', value: next })
      }
      const actor = entry.createdByName ?? entry.createdBy
      if (actor) {
        rows.push({ key: 'Assigned by', value: actor })
      }
      return rows
    }
    case ACTION_UNASSIGNED: {
      const rows = []
      const previous =
        details.previousAssigneeName ?? details.previousAssigneeId
      if (previous) {
        rows.push({ key: 'Previously assigned to', value: previous })
      }
      const actor = entry.createdByName ?? entry.createdBy
      if (actor) {
        rows.push({ key: 'Unassigned by', value: actor })
      }
      return rows
    }
    case ACTION_NOTE_ADDED: {
      const rows = []
      const actor = entry.createdByName ?? entry.createdBy
      if (actor) {
        rows.push({ key: 'Added by', value: actor })
      }
      const text = details.noteText
      if (typeof text === 'string' && text.length > 0) {
        rows.push({ key: 'Note', value: text, multiline: true })
      }
      return rows
    }
    case ACTION_APPLICATION_QUERIED: {
      // RA-291/RA-534: ReAccreditationQueryService stamps `actionId`,
      // `sections` (comma-joined) and `reason` onto this entry. The reason is
      // optional (RA-534) — render its row only when the caseworker entered
      // one, matching how every other action omits absent rows.
      const rows = []
      const areas = queriedSectionLabels(details.sections)
      if (areas.length > 0) {
        rows.push({ key: 'Areas queried', value: areas.join(', ') })
      }
      const actor = entry.createdByName ?? entry.createdBy
      if (actor) {
        rows.push({ key: 'Queried by', value: actor })
      }
      if (typeof details.reason === 'string' && details.reason.trim() !== '') {
        rows.push({ key: 'Reason', value: details.reason, multiline: true })
      }
      return rows
    }
    case ACTION_SLA_EXTENDED: {
      // RA-572 follow-up. `SlaService.AppendAuditEntry` stamps the mandatory
      // `reason` plus before/after snapshots of the SLA clock
      // (`before|afterStartedAt`, `before|afterTargetDuration`) and an
      // `additionalDuration`. The three duration values are raw ISO-8601
      // durations ("P30D") and are NOT rendered: instead the before/after
      // pairs are resolved into the two actual deadline DATES a caseworker
      // cares about, the same `startedAt + targetDuration` sum the backend
      // uses for `slaDueDate`. A pair that is absent or unparseable (early
      // migration entries) yields no row rather than a wrong or empty one.
      const rows = []
      const previousDeadline = slaDeadlineDisplay(
        details.beforeStartedAt,
        details.beforeTargetDuration
      )
      if (previousDeadline) {
        rows.push({ key: 'Previous deadline', value: previousDeadline })
      }
      const newDeadline = slaDeadlineDisplay(
        details.afterStartedAt,
        details.afterTargetDuration
      )
      if (newDeadline) {
        rows.push({ key: 'New deadline', value: newDeadline })
      }
      const actor = entry.createdByName ?? entry.createdBy
      if (actor) {
        rows.push({ key: 'Changed by', value: actor })
      }
      // The reason is the point of the entry, and users paste multi-line
      // text into the 500-character field, so it renders paragraph-per-line
      // rather than as one run-on line. Browsers normalise a `<textarea>`'s
      // line breaks to CRLF on submit, so the stored reason is normalised
      // back to LF here — the template splits on `\n` and would otherwise
      // leave a stray carriage return on the end of every paragraph.
      if (typeof details.reason === 'string' && details.reason.trim() !== '') {
        rows.push({
          key: 'Reason for change',
          value: details.reason.replaceAll('\r\n', '\n'),
          multiline: true
        })
      }
      return rows
    }
    case ACTION_NOTIFICATION_SENT:
    case ACTION_NOTIFICATION_SKIPPED:
    case ACTION_NOTIFICATION_FAILED:
      return notificationDetailRows(entry, details)
    case ACTION_STATUS_PUSH_SENT:
    case ACTION_STATUS_PUSH_SKIPPED:
    case ACTION_STATUS_PUSH_FAILED:
      return statusPushDetailRows(entry, details)
    case ACTION_ROUTED_TO_NATION: {
      // RA-125/RA-526: ReAccreditationNationRoutingHook stamps `nation` and
      // `derivedFrom` onto this entry's details. Both are rendered through
      // display-name maps: raw enum/internal values (`NorthernIreland`,
      // `submitted`) are not fit for a caseworker-facing page on their own.
      const rows = []
      if (details.nation) {
        rows.push({ key: 'Nation', value: nationLabel(details.nation) })
      }
      if (details.derivedFrom) {
        rows.push({
          key: 'Derived from',
          value: derivedFromDisplayName(details.derivedFrom)
        })
      }
      return rows
    }
    case ACTION_NATION_CORRECTED: {
      // RA-526: ReAccreditationNationCorrectionMigration stamps `from`/`to`
      // (and `reason`) onto this entry's details when it corrects a nation
      // that was wrongly derived by the pre-RA-526 postcode-based hook. The
      // migration applies corrections directly rather than a separate
      // dry-run pass, so this entry is the review trail for each one, not
      // just an audit nicety.
      const rows = []
      if (details.from) {
        rows.push({
          key: 'Previous nation',
          value: nationLabel(details.from)
        })
      }
      if (details.to) {
        rows.push({
          key: 'Corrected nation',
          value: nationLabel(details.to)
        })
      }
      if (details.reason) {
        rows.push({ key: 'Reason', value: details.reason, multiline: true })
      }
      return rows
    }
    default:
      return []
  }
}

/**
 * Project the structured details of a notification audit entry (RA-234).
 *
 * The backend's `ReAccreditationNotificationHook.SendAndRecordAsync` stamps
 * these fields onto the entry's `details` dictionary:
 *   - `templateKey`        — the GOV.UK Notify template that was (or would
 *                            have been) used; surfaced as "Notification type".
 *   - `recipient`          — the operator email (sent / failed only; absent
 *                            on a skip, which never resolved a recipient).
 *   - `reference`          — the Notify client reference (the work item id).
 *   - `nation`             — the UK nation the work item routed to, which is
 *                            what selects the regulator mailbox (regulator
 *                            sends only; absent on operator-facing ones, and
 *                            null when the item was never routed).
 *   - `providerMessageId`  — the Notify message id (sent / failed; may be
 *                            null on a failure that never reached Notify).
 *   - `reason`             — why a send was skipped (skipped only, e.g.
 *                            "missing-operator-email").
 *   - `errorMessage`       — the Notify error text (failed only).
 *
 * Only fields actually present on the entry are rendered, mirroring the
 * other audit actions; we never invent rows for absent fields.
 */
function notificationDetailRows(entry, details) {
  const rows = []
  if (details.templateKey) {
    rows.push({ key: 'Notification type', value: details.templateKey })
  }
  if (details.recipient) {
    rows.push({ key: 'Recipient', value: details.recipient })
  }
  if (details.reference) {
    rows.push({ key: 'Reference', value: details.reference })
  }
  if (details.nation) {
    rows.push({ key: 'Nation', value: details.nation })
  }
  if (details.providerMessageId) {
    rows.push({ key: 'Provider message ID', value: details.providerMessageId })
  }
  if (details.reason) {
    rows.push({ key: 'Reason', value: details.reason })
  }
  if (details.errorMessage) {
    rows.push({ key: 'Error', value: details.errorMessage, multiline: true })
  }
  const actor = entry.createdByName ?? entry.createdBy
  if (actor) {
    rows.push({ key: 'Triggered by', value: actor })
  }
  return rows
}

/**
 * Project the structured details of a Registration & Accreditation service
 * status-push audit entry (RA-368).
 *
 * The backend's `WorkItemStatusPushHook` stamps these fields onto the
 * entry's `details` dictionary for every generic action/transition it
 * pushes on to the Registration & Accreditation service:
 *   - `actionId` / `actionDisplayName` — the Case Management service action
 *     that fired the push.
 *   - `fromStateId` / `toStateId`      — the Case Management service state
 *     transition.
 *   - `toStateDisplayName`             — the state the Registration &
 *     Accreditation service was told about.
 *   - `reason`                         — why a push was skipped (skipped
 *                                        only, e.g. push disabled).
 *   - `errorMessage`                   — the error text (failed only).
 *
 * Only fields actually present on the entry are rendered, mirroring the
 * notification detail rows above; we never invent rows for absent fields.
 */
function statusPushDetailRows(entry, details) {
  const rows = []
  const action = details.actionDisplayName ?? details.actionId
  if (action) {
    rows.push({ key: 'Action', value: action })
  }
  if (details.fromStateId) {
    rows.push({ key: 'Previous state', value: details.fromStateId })
  }
  const toState = details.toStateDisplayName ?? details.toStateId
  if (toState) {
    rows.push({ key: 'New state', value: toState })
  }
  if (details.reason) {
    rows.push({ key: 'Reason', value: details.reason })
  }
  if (details.errorMessage) {
    rows.push({ key: 'Error', value: details.errorMessage, multiline: true })
  }
  const actor = entry.createdByName ?? entry.createdBy
  if (actor) {
    rows.push({ key: 'Triggered by', value: actor })
  }
  return rows
}

function formatPayloadForAudit(payload) {
  if (payload == null) {
    return ''
  }
  if (typeof payload === 'string') {
    return payload.trim() === '' ? '' : payload
  }
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return ''
  }
}
