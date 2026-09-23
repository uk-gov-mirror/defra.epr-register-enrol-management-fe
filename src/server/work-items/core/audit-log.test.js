import { describe, expect, test } from 'vitest'
import {
  decorateAuditLog,
  detailRowsForAuditEntry,
  notificationFailureDetected,
  summariseAuditEntry
} from './audit-log.js'

describe('summariseAuditEntry', () => {
  test('renders an action-applied entry as "Action (from -> to)"', () => {
    expect(
      summariseAuditEntry({
        action: 'action-applied',
        details: {
          actionId: 'approve',
          actionDisplayName: 'Approve',
          fromStateId: 'submitted',
          toStateId: 'approved'
        }
      })
    ).toBe('Approve (submitted → approved)')
  })

  test('renders an assignment entry showing the new assignee and the previous one', () => {
    expect(
      summariseAuditEntry({
        action: 'assigned',
        details: {
          assigneeId: 'carol-1',
          assigneeName: 'Carol',
          previousAssigneeId: 'bob-1',
          previousAssigneeName: 'Bob'
        }
      })
    ).toBe('Bob → Carol')
  })

  test('renders a self-assign (no previous assignee) as just the new assignee', () => {
    expect(
      summariseAuditEntry({
        action: 'assigned',
        details: { assigneeId: 'alice-1', assigneeName: 'Alice' }
      })
    ).toBe('Alice')
  })

  test('renders an unassigned entry showing the previous assignee', () => {
    expect(
      summariseAuditEntry({
        action: 'unassigned',
        details: {
          previousAssigneeId: 'alice-1',
          previousAssigneeName: 'Alice'
        }
      })
    ).toBe('was Alice')
  })

  test('returns an empty string for note-added (display name carries the meaning)', () => {
    expect(
      summariseAuditEntry({ action: 'note-added', details: { noteId: 'x' } })
    ).toBe('')
  })

  test('returns an empty string for unknown actions and bad input', () => {
    expect(summariseAuditEntry({ action: 'something-else', details: {} })).toBe(
      ''
    )
    expect(summariseAuditEntry(null)).toBe('')
    expect(summariseAuditEntry({})).toBe('')
  })

  // RA-291/RA-534: the query-detail entry summarises to the queried areas
  // (display names, comma-separated); the optional reason is left to the
  // disclosure.
  test('summarises an application-queried entry as its queried areas', () => {
    expect(
      summariseAuditEntry({
        action: 'application-queried',
        details: {
          actionId: 'query-during-assessment',
          sections: 'authority-to-issue,prn-tonnage',
          reason: 'Please confirm the figures.'
        }
      })
    ).toBe('Authority to issue, PRN tonnage')
  })
})

describe('decorateAuditLog', () => {
  test('returns an empty array when given a non-array', () => {
    expect(decorateAuditLog(undefined)).toEqual([])
    expect(decorateAuditLog(null)).toEqual([])
  })

  test('preserves order and adds a summary string per entry', () => {
    const entries = [
      {
        id: '1',
        action: 'unassigned',
        actionDisplayName: 'Unassigned',
        details: {},
        createdAt: '2026-04-27T09:00:00Z'
      },
      {
        id: '2',
        action: 'action-applied',
        actionDisplayName: 'Action applied',
        details: {
          actionId: 'approve',
          actionDisplayName: 'Approve',
          fromStateId: 'submitted',
          toStateId: 'approved'
        },
        createdAt: '2026-04-27T10:00:00Z'
      }
    ]
    const decorated = decorateAuditLog(entries)
    expect(decorated.map((e) => e.id)).toEqual(['1', '2'])
    expect(decorated[0].summary).toBe('')
    expect(decorated[1].summary).toBe('Approve (submitted → approved)')
    // Detail rows are projected alongside the summary so the template
    // can render a single disclosure per entry. The unassigned entry has
    // no previous assignee and no actor here, so it has nothing extra to
    // show; the action-applied entry surfaces the action plus from/to
    // states.
    expect(decorated[0].detailRows).toEqual([])
    expect(decorated[1].detailRows).toEqual([
      { key: 'Action', value: 'Approve' },
      { key: 'Previous state', value: 'submitted' },
      { key: 'New state', value: 'approved' }
    ])
    // Original fields are preserved.
    expect(decorated[1].createdAt).toBe('2026-04-27T10:00:00Z')
  })

  test('passes the supplied payload through to detail rows for a work-item-submitted entry', () => {
    const decorated = decorateAuditLog(
      [
        {
          id: '1',
          action: 'work-item-submitted',
          actionDisplayName: 'Work item submitted',
          details: { typeId: 're-accreditation', stateId: 'submitted' },
          createdAt: '2026-04-27T08:00:00Z'
        }
      ],
      { payload: { applicantName: 'Acme' } }
    )
    expect(decorated[0].detailRows).toEqual([
      { key: 'Type', value: 're-accreditation' },
      { key: 'Initial state', value: 'submitted' },
      {
        key: 'Payload',
        value: JSON.stringify({ applicantName: 'Acme' }, null, 2),
        preformatted: true
      }
    ])
  })
})

describe('detailRowsForAuditEntry', () => {
  test('returns an empty array for null/undefined/non-objects', () => {
    expect(detailRowsForAuditEntry(null)).toEqual([])
    expect(detailRowsForAuditEntry(undefined)).toEqual([])
    expect(detailRowsForAuditEntry('nope')).toEqual([])
  })

  test('returns an empty array when no useful detail and no actor are available', () => {
    expect(
      detailRowsForAuditEntry({ action: 'task-completed', details: {} })
    ).toEqual([])
    expect(
      detailRowsForAuditEntry({ action: 'action-applied', details: {} })
    ).toEqual([])
    expect(
      detailRowsForAuditEntry({ action: 'something-else', details: {} })
    ).toEqual([])
  })

  test('projects type, initial state, submitter and payload for a work-item-submitted entry', () => {
    expect(
      detailRowsForAuditEntry(
        {
          action: 'work-item-submitted',
          createdBy: 'frontend',
          createdByName: 'Acme submission',
          details: {
            typeId: 're-accreditation',
            stateId: 'submitted',
            templateVersion: 'v1'
          }
        },
        { payload: { applicantName: 'Acme' } }
      )
    ).toEqual([
      { key: 'Type', value: 're-accreditation' },
      { key: 'Initial state', value: 'submitted' },
      { key: 'Submitted by', value: 'Acme submission' },
      {
        key: 'Payload',
        value: JSON.stringify({ applicantName: 'Acme' }, null, 2),
        preformatted: true
      }
    ])
  })

  test('omits the payload row when no payload is supplied or it is empty', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'work-item-submitted',
        createdByName: 'Acme submission',
        details: { typeId: 're-accreditation', stateId: 'submitted' }
      })
    ).toEqual([
      { key: 'Type', value: 're-accreditation' },
      { key: 'Initial state', value: 'submitted' },
      { key: 'Submitted by', value: 'Acme submission' }
    ])
    expect(
      detailRowsForAuditEntry(
        {
          action: 'work-item-submitted',
          details: { typeId: 're-accreditation' }
        },
        { payload: null }
      )
    ).toEqual([{ key: 'Type', value: 're-accreditation' }])
    expect(
      detailRowsForAuditEntry(
        {
          action: 'work-item-submitted',
          details: { typeId: 're-accreditation' }
        },
        { payload: '   ' }
      )
    ).toEqual([{ key: 'Type', value: 're-accreditation' }])
  })

  test('renders a string payload verbatim on a work-item-submitted entry', () => {
    expect(
      detailRowsForAuditEntry(
        {
          action: 'work-item-submitted',
          details: { typeId: 're-accreditation' }
        },
        { payload: 'raw-body' }
      )
    ).toEqual([
      { key: 'Type', value: 're-accreditation' },
      { key: 'Payload', value: 'raw-body', preformatted: true }
    ])
  })

  test('returns an empty array when JSON.stringify throws on a circular payload', () => {
    const circular = {}
    circular.self = circular
    expect(
      detailRowsForAuditEntry(
        {
          action: 'work-item-submitted',
          details: {}
        },
        { payload: circular }
      )
    ).toEqual([])
  })

  test('projects action, from/to state and actor for an action-applied entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'action-applied',
        createdBy: 'alice-1',
        createdByName: 'Alice Anderson',
        details: {
          actionId: 'approve',
          actionDisplayName: 'Approve',
          fromStateId: 'submitted',
          toStateId: 'approved'
        }
      })
    ).toEqual([
      { key: 'Action', value: 'Approve' },
      { key: 'Previous state', value: 'submitted' },
      { key: 'New state', value: 'approved' },
      { key: 'Applied by', value: 'Alice Anderson' }
    ])
  })

  test('projects previous assignee, new assignee and the actor for an assigned entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'assigned',
        createdBy: 'carol-1',
        createdByName: 'Carol Caseworker',
        details: {
          assigneeId: 'bob-2',
          assigneeName: 'Bob Bobbinson',
          previousAssigneeId: 'alice-1',
          previousAssigneeName: 'Alice Anderson'
        }
      })
    ).toEqual([
      { key: 'Previously assigned to', value: 'Alice Anderson' },
      { key: 'Now assigned to', value: 'Bob Bobbinson' },
      { key: 'Assigned by', value: 'Carol Caseworker' }
    ])
  })

  test('shows "Nobody" as the previous assignee when a work item is assigned for the first time', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'assigned',
        createdBy: 'carol-1',
        createdByName: 'Carol Caseworker',
        details: {
          assigneeId: 'bob-2',
          assigneeName: 'Bob Bobbinson'
        }
      })
    ).toEqual([
      { key: 'Previously assigned to', value: 'Nobody' },
      { key: 'Now assigned to', value: 'Bob Bobbinson' },
      { key: 'Assigned by', value: 'Carol Caseworker' }
    ])
  })

  test('falls back to ids when names are missing on an assigned entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'assigned',
        createdBy: 'carol-1',
        details: {
          assigneeId: 'bob-2',
          previousAssigneeId: 'alice-1'
        }
      })
    ).toEqual([
      { key: 'Previously assigned to', value: 'alice-1' },
      { key: 'Now assigned to', value: 'bob-2' },
      { key: 'Assigned by', value: 'carol-1' }
    ])
  })

  test('projects previous assignee and the actor for an unassigned entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'unassigned',
        createdBy: 'carol-1',
        createdByName: 'Carol Caseworker',
        details: {
          previousAssigneeId: 'alice-1',
          previousAssigneeName: 'Alice Anderson'
        }
      })
    ).toEqual([
      { key: 'Previously assigned to', value: 'Alice Anderson' },
      { key: 'Unassigned by', value: 'Carol Caseworker' }
    ])
  })

  test('projects the note body and actor for a note-added entry as a multiline row', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'note-added',
        createdBy: 'alice-1',
        createdByName: 'Alice Anderson',
        details: { noteId: 'n-1', noteText: 'Line 1\nLine 2' }
      })
    ).toEqual([
      { key: 'Added by', value: 'Alice Anderson' },
      { key: 'Note', value: 'Line 1\nLine 2', multiline: true }
    ])
  })

  test('returns an empty array for a note-added entry with no body and no actor', () => {
    expect(
      detailRowsForAuditEntry({ action: 'note-added', details: {} })
    ).toEqual([])
    expect(
      detailRowsForAuditEntry({
        action: 'note-added',
        details: { noteText: '' }
      })
    ).toEqual([])
  })

  test('projects the nation and derivedFrom for a routed-to-nation entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'routed-to-nation',
        details: { nation: 'England', derivedFrom: 'submitted' }
      })
    ).toEqual([
      { key: 'Nation', value: 'England' },
      { key: 'Derived from', value: "Registration's regulator" }
    ])
  })

  test('formats NorthernIreland with a space for a routed-to-nation entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'routed-to-nation',
        details: { nation: 'NorthernIreland', derivedFrom: 'submitted' }
      })
    ).toEqual([
      { key: 'Nation', value: 'Northern Ireland' },
      { key: 'Derived from', value: "Registration's regulator" }
    ])
  })

  test('humanises the legacy site-address derivedFrom value', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'routed-to-nation',
        details: { nation: 'England', derivedFrom: 'site-address' }
      })
    ).toEqual([
      { key: 'Nation', value: 'England' },
      { key: 'Derived from', value: 'Site address' }
    ])
  })

  test('labels the default-england derivedFrom value for a routed-to-nation entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'routed-to-nation',
        details: { nation: 'England', derivedFrom: 'default-england' }
      })
    ).toEqual([
      { key: 'Nation', value: 'England' },
      {
        key: 'Derived from',
        value: 'No nation provided (defaulted to England)'
      }
    ])
  })

  test('falls back to the raw value for an unrecognised derivedFrom or nation', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'routed-to-nation',
        details: { nation: 'Atlantis', derivedFrom: 'something-new' }
      })
    ).toEqual([
      { key: 'Nation', value: 'Atlantis' },
      { key: 'Derived from', value: 'something-new' }
    ])
  })

  test('omits the derivedFrom row for a routed-to-nation entry with no derivedFrom', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'routed-to-nation',
        details: { nation: 'England' }
      })
    ).toEqual([{ key: 'Nation', value: 'England' }])
  })

  test('returns an empty array for a routed-to-nation entry with no nation', () => {
    expect(
      detailRowsForAuditEntry({ action: 'routed-to-nation', details: {} })
    ).toEqual([])
  })

  test('projects previous nation, corrected nation and reason for a nation-corrected entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'nation-corrected',
        details: {
          from: 'England',
          to: 'Wales',
          reason: 'payload.nation was derived by the pre-RA-526 hook.'
        }
      })
    ).toEqual([
      { key: 'Previous nation', value: 'England' },
      { key: 'Corrected nation', value: 'Wales' },
      {
        key: 'Reason',
        value: 'payload.nation was derived by the pre-RA-526 hook.',
        multiline: true
      }
    ])
  })

  test('omits absent fields for a nation-corrected entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'nation-corrected',
        details: { from: 'England', to: 'Wales' }
      })
    ).toEqual([
      { key: 'Previous nation', value: 'England' },
      { key: 'Corrected nation', value: 'Wales' }
    ])
  })

  test('returns an empty array for a nation-corrected entry with no details', () => {
    expect(
      detailRowsForAuditEntry({ action: 'nation-corrected', details: {} })
    ).toEqual([])
  })

  test('formats NorthernIreland with a space for a nation-corrected entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'nation-corrected',
        details: { from: 'NorthernIreland', to: 'England' }
      })
    ).toEqual([
      { key: 'Previous nation', value: 'Northern Ireland' },
      { key: 'Corrected nation', value: 'England' }
    ])
  })

  // RA-291/RA-534 — the query-detail entry. AC2: a reason the caseworker
  // entered must reach the application history; an omitted one must not
  // leave an empty row.
  test('projects areas, actor and reason for an application-queried entry', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'application-queried',
        createdByName: 'Stub Caseworker One',
        details: {
          actionId: 'query-during-assessment',
          sections: 'authority-to-issue,sampling-and-inspection-plan',
          reason: 'Please re-upload the sampling and inspection plan.'
        }
      })
    ).toEqual([
      {
        key: 'Areas queried',
        value: 'Authority to issue, Sampling and inspection plan'
      },
      { key: 'Queried by', value: 'Stub Caseworker One' },
      {
        key: 'Reason',
        value: 'Please re-upload the sampling and inspection plan.',
        multiline: true
      }
    ])
  })

  test('omits the Reason row for an application-queried entry with no reason', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'application-queried',
        createdByName: 'Stub Caseworker One',
        details: {
          actionId: 'query-during-assessment',
          sections: 'business-plan',
          reason: ''
        }
      })
    ).toEqual([
      { key: 'Areas queried', value: 'Business plan' },
      { key: 'Queried by', value: 'Stub Caseworker One' }
    ])
  })

  test('accepts an already-split sections array and renders unknown values verbatim', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'application-queried',
        details: { sections: ['business-plan', 'mystery-area'] }
      })
    ).toEqual([{ key: 'Areas queried', value: 'Business plan, mystery-area' }])
  })

  test('returns an empty array for an application-queried entry with no sections, reason or actor', () => {
    expect(
      detailRowsForAuditEntry({ action: 'application-queried', details: {} })
    ).toEqual([])
  })
})

describe('decorateAuditLog — workItemSnapshot rows', () => {
  // Auxiliary action (no state in its own detail rows), so it takes the
  // per-entry context-block "State" row from its OWN `stateId`.
  const baseEntry = {
    id: '1',
    action: 'unassigned',
    actionDisplayName: 'Unassigned',
    stateId: 'submitted',
    details: {},
    createdAt: '2026-05-01T09:00:00Z'
  }

  // Mirrors the controller's resolver (state code → display name).
  const resolveStateDisplayName = (stateId) =>
    ({ submitted: 'Not started', 'duly-made': 'Duly made' })[stateId] ?? stateId

  test('appends snapshot rows to every entry when workItemSnapshot is provided', () => {
    const snapshot = {
      orgId: 'APP-001',
      typeDisplayName: 'Re-accreditation',
      submittedAt: '2026-05-01T08:00:00Z',
      submittedBy: 'frontend',
      lastModifiedAt: '2026-05-01T09:00:00Z',
      assignedToName: 'Alice Anderson'
    }
    const [decorated] = decorateAuditLog([baseEntry], {
      workItemSnapshot: snapshot,
      resolveStateDisplayName
    })
    const keys = decorated.detailRows.map((r) => r.key)
    expect(keys).toContain('Org ID')
    expect(keys).toContain('Type')
    expect(keys).toContain('State')
    expect(keys).toContain('Submitted at')
    expect(keys).toContain('Submitted by')
    expect(keys).toContain('Last modified')
    expect(keys).toContain('Assigned to')
  })

  test('shows "Unassigned" when assignedToName is null', () => {
    const [decorated] = decorateAuditLog([baseEntry], {
      workItemSnapshot: { assignedToName: null }
    })
    const assignedRow = decorated.detailRows.find(
      (r) => r.key === 'Assigned to'
    )
    expect(assignedRow?.value).toBe('Unassigned')
  })

  test('omits optional snapshot rows when values are absent', () => {
    const [decorated] = decorateAuditLog([baseEntry], {
      workItemSnapshot: { assignedToName: 'Alice' }
    })
    const keys = decorated.detailRows.map((r) => r.key)
    expect(keys).not.toContain('Org ID')
    expect(keys).not.toContain('Submitted at')
    expect(keys).not.toContain('Last modified')
    expect(keys).toContain('Assigned to')
  })

  test.each(['routed-to-nation', 'nation-corrected'])(
    'omits ALL snapshot context rows for a %s entry, unlike every other action',
    (action) => {
      const snapshot = {
        orgId: 'APP-001',
        typeDisplayName: 'Re-accreditation',
        submittedAt: '2026-05-01T08:00:00Z',
        submittedBy: 'frontend',
        lastModifiedAt: '2026-05-01T09:00:00Z',
        assignedToName: 'Alice Anderson'
      }
      const entry = {
        id: '1',
        action,
        actionDisplayName: 'irrelevant here',
        stateId: 'submitted',
        details: {
          nation: 'England',
          derivedFrom: 'submitted',
          from: 'Wales',
          to: 'England'
        },
        createdAt: '2026-05-01T09:00:00Z'
      }
      const [decorated] = decorateAuditLog([entry], {
        workItemSnapshot: snapshot,
        resolveStateDisplayName
      })
      const keys = decorated.detailRows.map((r) => r.key)
      expect(keys).not.toContain('Org ID')
      expect(keys).not.toContain('Type')
      expect(keys).not.toContain('State')
      expect(keys).not.toContain('Submitted at')
      expect(keys).not.toContain('Submitted by')
      expect(keys).not.toContain('Last modified')
      expect(keys).not.toContain('Assigned to')
      // The entry's own rows must still be there — only the context block is suppressed.
      expect(decorated.detailRows.length).toBeGreaterThan(0)
    }
  )

  test('appends snapshot rows after entry-specific rows', () => {
    const [decorated] = decorateAuditLog(
      [
        {
          id: '1',
          action: 'task-completed',
          createdByName: 'Alice',
          details: {
            taskDisplayName: 'Check eligibility',
            stateId: 'submitted'
          }
        }
      ],
      {
        workItemSnapshot: {
          typeDisplayName: 'Re-accreditation',
          assignedToName: null
        }
      }
    )
    const keys = decorated.detailRows.map((r) => r.key)
    expect(keys.indexOf('Task')).toBeLessThan(keys.indexOf('Type'))
  })

  test('returns no snapshot rows when workItemSnapshot is absent', () => {
    const [decorated] = decorateAuditLog([baseEntry])
    expect(decorated.detailRows).toEqual([])
  })

  test('returns no snapshot rows when workItemSnapshot is null', () => {
    const [decorated] = decorateAuditLog([baseEntry], {
      workItemSnapshot: null
    })
    expect(decorated.detailRows).toEqual([])
  })
})

describe('decorateAuditLog — per-entry State row (epr-rr9s)', () => {
  const snapshot = {
    orgId: 'APP-001',
    typeDisplayName: 'Re-accreditation',
    assignedToName: 'Alice Anderson'
  }
  // State code → display name, mirroring the controller's resolver. Note
  // the CURRENT work item is (say) "Duly made"; historical entries must
  // NOT show that.
  const resolveStateDisplayName = (stateId) =>
    ({ submitted: 'Not started', 'duly-made': 'Duly made' })[stateId] ?? stateId

  const stateRowOf = (decorated) =>
    decorated.detailRows.find((r) => r.key === 'State')

  test('renders the entry OWN stateId, resolved via the display-name machinery', () => {
    // A "Routed to nation"-style early entry: it happened while the item
    // was still "Not started", even though the item is now "Duly made".
    const [decorated] = decorateAuditLog(
      [
        {
          id: 'r1',
          action: 'notification-sent',
          stateId: 'submitted',
          details: { templateKey: 'routed-to-nation', nation: 'england' },
          createdAt: '2026-05-01T08:05:00Z'
        }
      ],
      { workItemSnapshot: snapshot, resolveStateDisplayName }
    )
    expect(stateRowOf(decorated)?.value).toBe('Not started')
    expect(stateRowOf(decorated)?.value).not.toBe('Duly made')
  })

  test('does NOT stamp the current work-item state onto historical entries', () => {
    // Two entries at different points in the item's life. Each must show
    // its own state, never a single shared (current) value.
    const [early, later] = decorateAuditLog(
      [
        {
          id: 'e1',
          action: 'assigned',
          stateId: 'submitted',
          details: { assigneeName: 'Bob' },
          createdAt: '2026-05-01T08:10:00Z'
        },
        {
          id: 'e2',
          action: 'assigned',
          stateId: 'duly-made',
          details: { assigneeName: 'Carol' },
          createdAt: '2026-05-02T08:10:00Z'
        }
      ],
      { workItemSnapshot: snapshot, resolveStateDisplayName }
    )
    expect(stateRowOf(early)?.value).toBe('Not started')
    expect(stateRowOf(later)?.value).toBe('Duly made')
  })

  test('omits the State row entirely when the entry has no stateId (old documents)', () => {
    const [decorated] = decorateAuditLog(
      [
        {
          id: 'old1',
          action: 'assigned',
          // no stateId — predates the backend change
          details: { assigneeName: 'Bob' },
          createdAt: '2026-05-01T08:10:00Z'
        }
      ],
      { workItemSnapshot: snapshot, resolveStateDisplayName }
    )
    expect(stateRowOf(decorated)).toBeUndefined()
    // and it must NOT have fallen back to the current work-item state
    const values = decorated.detailRows.map((r) => r.value)
    expect(values).not.toContain('Duly made')
  })

  test('omits the State row when stateId is null (never falls back to current state)', () => {
    const [decorated] = decorateAuditLog(
      [
        {
          id: 'old2',
          action: 'note-added',
          stateId: null,
          details: { noteText: 'A note' },
          createdAt: '2026-05-01T08:10:00Z'
        }
      ],
      { workItemSnapshot: snapshot, resolveStateDisplayName }
    )
    expect(stateRowOf(decorated)).toBeUndefined()
  })

  test('there is no appended current-state row (the historical-state bug is gone)', () => {
    // The snapshot no longer carries stateDisplayName; even if a stray
    // stateDisplayName were present it must be ignored.
    const [decorated] = decorateAuditLog(
      [
        {
          id: 'a1',
          action: 'unassigned',
          stateId: 'submitted',
          details: {},
          createdAt: '2026-05-01T08:10:00Z'
        }
      ],
      {
        workItemSnapshot: { ...snapshot, stateDisplayName: 'Duly made' },
        resolveStateDisplayName
      }
    )
    const stateValues = decorated.detailRows
      .filter((r) => r.key === 'State')
      .map((r) => r.value)
    expect(stateValues).toEqual(['Not started'])
  })

  test('suppresses the redundant State row on state-bearing actions', () => {
    // work-item-submitted already shows "Initial state" and action-applied
    // already shows Previous/New state, so the context-block State row must
    // not duplicate those.
    const [submitted, applied] = decorateAuditLog(
      [
        {
          id: 's1',
          action: 'work-item-submitted',
          stateId: 'submitted',
          details: { typeId: 're-accreditation', stateId: 'submitted' },
          createdAt: '2026-05-01T08:00:00Z'
        },
        {
          id: 's2',
          action: 'action-applied',
          stateId: 'duly-made',
          details: { fromStateId: 'submitted', toStateId: 'duly-made' },
          createdAt: '2026-05-01T09:00:00Z'
        }
      ],
      { workItemSnapshot: snapshot, resolveStateDisplayName }
    )
    // No context-block State row on either — their own event rows carry it.
    expect(submitted.detailRows.filter((r) => r.key === 'State')).toHaveLength(
      0
    )
    expect(applied.detailRows.filter((r) => r.key === 'State')).toHaveLength(0)
  })

  test('suppresses the context State row on Registration & Accreditation service status-push actions', () => {
    // statusPushDetailRows already emits Previous state / New state for all
    // three status-push actions, so the context-block State row would be a
    // second, differently-worded state on the same entry: New state reads
    // details.toStateDisplayName (the label the push hook recorded for the
    // Registration & Accreditation service) while the context row resolves
    // entry.stateId through the Case Management service state definitions.
    // One entry must not show both.
    const entries = decorateAuditLog(
      ['status-push-sent', 'status-push-skipped', 'status-push-failed'].map(
        (action, i) => ({
          id: `p${i}`,
          action,
          stateId: 'duly-made',
          details: {
            actionId: 'duly-make',
            fromStateId: 'submitted',
            toStateId: 'duly-made',
            toStateDisplayName: 'DULY_MADE'
          },
          createdAt: '2026-05-01T10:00:00Z'
        })
      ),
      { workItemSnapshot: snapshot, resolveStateDisplayName }
    )

    for (const entry of entries) {
      expect(entry.detailRows.filter((r) => r.key === 'State')).toHaveLength(0)
      // The entry's own New state row still carries the Registration &
      // Accreditation service vocabulary.
      expect(entry.detailRows.find((r) => r.key === 'New state')?.value).toBe(
        'DULY_MADE'
      )
    }
  })

  test('renders a per-entry State row for retired task actions post-RA-410', () => {
    // RA-410 removed the task framework and its detail-row handling, so a
    // historical task-completed entry no longer shows its own State row.
    // When such an entry carries a per-entry stateId it must now surface it
    // via the context-block State row (resolved to a display name), NOT be
    // suppressed as if it were still state-bearing.
    const [completed] = decorateAuditLog(
      [
        {
          id: 't1',
          action: 'task-completed',
          stateId: 'submitted',
          details: { taskId: 't', stateId: 'submitted' },
          createdAt: '2026-05-01T10:00:00Z'
        }
      ],
      { workItemSnapshot: snapshot, resolveStateDisplayName }
    )
    const stateRows = completed.detailRows.filter((r) => r.key === 'State')
    expect(stateRows).toHaveLength(1)
    expect(stateRows[0].value).toBe('Not started')
  })

  test('falls back to the raw stateId when no resolver is supplied', () => {
    const [decorated] = decorateAuditLog(
      [
        {
          id: 'nr1',
          action: 'assigned',
          stateId: 'submitted',
          details: { assigneeName: 'Bob' },
          createdAt: '2026-05-01T08:10:00Z'
        }
      ],
      { workItemSnapshot: snapshot }
    )
    expect(stateRowOf(decorated)?.value).toBe('submitted')
  })
})

describe('decorateAuditLog (RA-129)', () => {
  test('returns empty array when entries is not an array', () => {
    expect(decorateAuditLog(null)).toEqual([])
    expect(decorateAuditLog(undefined)).toEqual([])
    expect(decorateAuditLog('nope')).toEqual([])
  })

  test('uses backend actionDisplayName when present and non-blank', () => {
    const [decorated] = decorateAuditLog([
      {
        action: 'task-status-changed',
        actionDisplayName: 'Custom label',
        details: {}
      }
    ])
    expect(decorated.actionDisplayName).toBe('Custom label')
  })

  test('falls back to the lookup when backend actionDisplayName is missing', () => {
    const [decorated] = decorateAuditLog([
      { action: 'notification-sent', details: {} }
    ])
    expect(decorated.actionDisplayName).toBe('Notification sent')
  })

  test('falls back to the action id when there is no lookup entry', () => {
    const [decorated] = decorateAuditLog([{ action: 'unknown-action' }])
    expect(decorated.actionDisplayName).toBe('unknown-action')
  })

  test('treats blank backend actionDisplayName as missing', () => {
    const [decorated] = decorateAuditLog([
      { action: 'notification-sent', actionDisplayName: '   ', details: {} }
    ])
    expect(decorated.actionDisplayName).toBe('Notification sent')
  })

  test('falls back to empty string when both backend label and action are missing', () => {
    const [decorated] = decorateAuditLog([{ details: {} }])
    expect(decorated.actionDisplayName).toBe('')
  })

  test('handles a null entry within the array gracefully', () => {
    const [decorated] = decorateAuditLog([null])
    expect(decorated.actionDisplayName).toBe('')
    expect(decorated.summary).toBe('')
    expect(decorated.detailRows).toEqual([])
    expect(decorated.isFailure).toBe(false)
  })
})

describe('notification audit entries (RA-234)', () => {
  describe('actionDisplayNameFor fallbacks', () => {
    test('notification-sent falls back to "Notification sent"', () => {
      const [decorated] = decorateAuditLog([
        { action: 'notification-sent', details: {} }
      ])
      expect(decorated.actionDisplayName).toBe('Notification sent')
    })

    test('notification-skipped falls back to "Notification not sent"', () => {
      const [decorated] = decorateAuditLog([
        { action: 'notification-skipped', details: {} }
      ])
      expect(decorated.actionDisplayName).toBe('Notification not sent')
    })

    test('notification-failed falls back to "Notification failed"', () => {
      const [decorated] = decorateAuditLog([
        { action: 'notification-failed', details: {} }
      ])
      expect(decorated.actionDisplayName).toBe('Notification failed')
    })

    test('uses the backend actionDisplayName when present', () => {
      const [decorated] = decorateAuditLog([
        {
          action: 'notification-sent',
          actionDisplayName: 'Submission confirmation email sent',
          details: {}
        }
      ])
      expect(decorated.actionDisplayName).toBe(
        'Submission confirmation email sent'
      )
    })
  })

  describe('summariseAuditEntry', () => {
    test('notification-sent summarises to the recipient', () => {
      expect(
        summariseAuditEntry({
          action: 'notification-sent',
          details: { recipient: 'op@example.com' }
        })
      ).toBe('op@example.com')
    })

    test('notification-sent summary is empty when recipient absent', () => {
      expect(
        summariseAuditEntry({ action: 'notification-sent', details: {} })
      ).toBe('')
    })

    test('notification-skipped summarises to the reason', () => {
      expect(
        summariseAuditEntry({
          action: 'notification-skipped',
          details: { reason: 'missing-operator-email' }
        })
      ).toBe('missing-operator-email')
    })

    test('notification-skipped summary is empty when reason absent', () => {
      expect(
        summariseAuditEntry({ action: 'notification-skipped', details: {} })
      ).toBe('')
    })

    test('notification-failed summarises to the error message', () => {
      expect(
        summariseAuditEntry({
          action: 'notification-failed',
          details: { errorMessage: 'Notify returned 500' }
        })
      ).toBe('Notify returned 500')
    })

    test('notification-failed summary is empty when error message absent', () => {
      expect(
        summariseAuditEntry({ action: 'notification-failed', details: {} })
      ).toBe('')
    })
  })

  describe('detailRowsForAuditEntry', () => {
    test('projects all fields for a notification-sent entry', () => {
      expect(
        detailRowsForAuditEntry({
          action: 'notification-sent',
          createdBy: 'frontend',
          createdByName: 'Carol Caseworker',
          details: {
            templateKey: 'SubmissionConfirmation',
            recipient: 'op@example.com',
            reference: 'wi-1',
            providerMessageId: 'msg-123'
          }
        })
      ).toEqual([
        { key: 'Notification type', value: 'SubmissionConfirmation' },
        { key: 'Recipient', value: 'op@example.com' },
        { key: 'Reference', value: 'wi-1' },
        { key: 'Provider message ID', value: 'msg-123' },
        { key: 'Triggered by', value: 'Carol Caseworker' }
      ])
    })

    test('projects the nation row for a regulator notification-sent entry', () => {
      expect(
        detailRowsForAuditEntry({
          action: 'notification-sent',
          createdByName: 'Carol Caseworker',
          details: {
            templateKey: 'OfficerAssignment',
            recipient: 'packagingnotifications@environment-agency.gov.uk',
            reference: 'wi-3',
            nation: 'England',
            providerMessageId: 'msg-456'
          }
        })
      ).toEqual([
        { key: 'Notification type', value: 'OfficerAssignment' },
        {
          key: 'Recipient',
          value: 'packagingnotifications@environment-agency.gov.uk'
        },
        { key: 'Reference', value: 'wi-3' },
        { key: 'Nation', value: 'England' },
        { key: 'Provider message ID', value: 'msg-456' },
        { key: 'Triggered by', value: 'Carol Caseworker' }
      ])
    })

    test('projects the nation row on a skipped regulator entry alongside the reason', () => {
      // The backend records nation even when it could not resolve a mailbox for
      // it — that pairing is what explains the skip to a caseworker.
      expect(
        detailRowsForAuditEntry({
          action: 'notification-skipped',
          createdByName: 'Carol Caseworker',
          details: {
            templateKey: 'OfficerAssignment',
            reference: 'wi-4',
            nation: 'Scotland',
            reason: 'missing-regulator-mailbox'
          }
        })
      ).toEqual([
        { key: 'Notification type', value: 'OfficerAssignment' },
        { key: 'Reference', value: 'wi-4' },
        { key: 'Nation', value: 'Scotland' },
        { key: 'Reason', value: 'missing-regulator-mailbox' },
        { key: 'Triggered by', value: 'Carol Caseworker' }
      ])
    })

    test('omits the nation row when the work item was never routed', () => {
      // nation is explicitly null on an unrouted item; it must not render as an
      // empty row.
      const rows = detailRowsForAuditEntry({
        action: 'notification-skipped',
        details: {
          templateKey: 'RegulatorSubmission',
          reference: 'wi-5',
          nation: null,
          reason: 'missing-regulator-mailbox'
        }
      })
      expect(rows.map((r) => r.key)).not.toContain('Nation')
    })

    test('projects template, reference and reason for a notification-skipped entry (no recipient)', () => {
      expect(
        detailRowsForAuditEntry({
          action: 'notification-skipped',
          createdByName: 'Carol Caseworker',
          details: {
            templateKey: 'SubmissionConfirmation',
            reference: 'wi-1',
            reason: 'missing-operator-email'
          }
        })
      ).toEqual([
        { key: 'Notification type', value: 'SubmissionConfirmation' },
        { key: 'Reference', value: 'wi-1' },
        { key: 'Reason', value: 'missing-operator-email' },
        { key: 'Triggered by', value: 'Carol Caseworker' }
      ])
    })

    test('projects the error message as a multiline row for a notification-failed entry', () => {
      expect(
        detailRowsForAuditEntry({
          action: 'notification-failed',
          createdBy: 'frontend',
          details: {
            templateKey: 'Decision',
            recipient: 'op@example.com',
            reference: 'wi-2',
            providerMessageId: null,
            errorMessage: 'Notify returned 500\nstatus: ServiceUnavailable'
          }
        })
      ).toEqual([
        { key: 'Notification type', value: 'Decision' },
        { key: 'Recipient', value: 'op@example.com' },
        { key: 'Reference', value: 'wi-2' },
        {
          key: 'Error',
          value: 'Notify returned 500\nstatus: ServiceUnavailable',
          multiline: true
        },
        { key: 'Triggered by', value: 'frontend' }
      ])
    })

    test('returns an empty array for a notification entry with no details and no actor', () => {
      expect(
        detailRowsForAuditEntry({ action: 'notification-sent', details: {} })
      ).toEqual([])
      expect(
        detailRowsForAuditEntry({ action: 'notification-failed' })
      ).toEqual([])
    })
  })

  describe('isFailure flag on decorateAuditLog', () => {
    test('marks notification-failed entries as failures', () => {
      const [decorated] = decorateAuditLog([
        { action: 'notification-failed', details: {} }
      ])
      expect(decorated.isFailure).toBe(true)
    })

    test('does not mark notification-sent or notification-skipped as failures', () => {
      const decorated = decorateAuditLog([
        { action: 'notification-sent', details: {} },
        { action: 'notification-skipped', details: {} }
      ])
      expect(decorated[0].isFailure).toBe(false)
      expect(decorated[1].isFailure).toBe(false)
    })

    test('does not mark ordinary actions as failures', () => {
      const [decorated] = decorateAuditLog([
        { action: 'task-completed', details: {} }
      ])
      expect(decorated.isFailure).toBe(false)
    })
  })
})

describe('Registration & Accreditation service status-push audit entries (RA-368)', () => {
  describe('actionDisplayNameFor fallbacks', () => {
    test('status-push-sent falls back to "Status sent to the Registration & Accreditation service"', () => {
      const [decorated] = decorateAuditLog([
        { action: 'status-push-sent', details: {} }
      ])
      expect(decorated.actionDisplayName).toBe(
        'Status sent to the Registration & Accreditation service'
      )
    })

    test('status-push-skipped falls back to "Status not sent to the Registration & Accreditation service (disabled)"', () => {
      const [decorated] = decorateAuditLog([
        { action: 'status-push-skipped', details: {} }
      ])
      expect(decorated.actionDisplayName).toBe(
        'Status not sent to the Registration & Accreditation service (disabled)'
      )
    })

    test('status-push-failed falls back to "Status failed to send to the Registration & Accreditation service"', () => {
      const [decorated] = decorateAuditLog([
        { action: 'status-push-failed', details: {} }
      ])
      expect(decorated.actionDisplayName).toBe(
        'Status failed to send to the Registration & Accreditation service'
      )
    })
  })

  describe('summariseAuditEntry', () => {
    test('status-push-sent summarises to the new state display name', () => {
      expect(
        summariseAuditEntry({
          action: 'status-push-sent',
          details: { toStateId: 'approved', toStateDisplayName: 'Approved' }
        })
      ).toBe('Approved')
    })

    test('status-push-sent falls back to the raw state id when no display name', () => {
      expect(
        summariseAuditEntry({
          action: 'status-push-sent',
          details: { toStateId: 'approved' }
        })
      ).toBe('approved')
    })

    test('status-push-skipped summarises to the reason', () => {
      expect(
        summariseAuditEntry({
          action: 'status-push-skipped',
          details: { reason: 'push-disabled' }
        })
      ).toBe('push-disabled')
    })

    test('status-push-failed summarises to the error message', () => {
      expect(
        summariseAuditEntry({
          action: 'status-push-failed',
          details: {
            errorMessage: 'Registration & Accreditation service returned 500'
          }
        })
      ).toBe('Registration & Accreditation service returned 500')
    })
  })

  describe('detailRowsForAuditEntry', () => {
    test('projects action, from/to state and actor for a status-push-sent entry', () => {
      expect(
        detailRowsForAuditEntry({
          action: 'status-push-sent',
          createdByName: 'System',
          details: {
            actionId: 'approve',
            actionDisplayName: 'Approve',
            fromStateId: 'awaiting-decision',
            toStateId: 'approved',
            toStateDisplayName: 'Approved'
          }
        })
      ).toEqual([
        { key: 'Action', value: 'Approve' },
        { key: 'Previous state', value: 'awaiting-decision' },
        { key: 'New state', value: 'Approved' },
        { key: 'Triggered by', value: 'System' }
      ])
    })

    test('projects the reason for a status-push-skipped entry', () => {
      expect(
        detailRowsForAuditEntry({
          action: 'status-push-skipped',
          details: {
            actionId: 'approve',
            toStateId: 'approved',
            reason: 'push-disabled'
          }
        })
      ).toEqual([
        { key: 'Action', value: 'approve' },
        { key: 'New state', value: 'approved' },
        { key: 'Reason', value: 'push-disabled' }
      ])
    })

    test('projects the error message as a multiline row for a status-push-failed entry', () => {
      expect(
        detailRowsForAuditEntry({
          action: 'status-push-failed',
          details: {
            actionId: 'approve',
            toStateId: 'approved',
            errorMessage:
              'Registration & Accreditation service returned 500\nstatus: ServiceUnavailable'
          }
        })
      ).toEqual([
        { key: 'Action', value: 'approve' },
        { key: 'New state', value: 'approved' },
        {
          key: 'Error',
          value:
            'Registration & Accreditation service returned 500\nstatus: ServiceUnavailable',
          multiline: true
        }
      ])
    })

    test('returns an empty array for a status-push entry with no details and no actor', () => {
      expect(
        detailRowsForAuditEntry({ action: 'status-push-sent', details: {} })
      ).toEqual([])
      expect(detailRowsForAuditEntry({ action: 'status-push-failed' })).toEqual(
        []
      )
    })
  })

  describe('isFailure flag on decorateAuditLog', () => {
    test('marks status-push-failed entries as failures', () => {
      const [decorated] = decorateAuditLog([
        { action: 'status-push-failed', details: {} }
      ])
      expect(decorated.isFailure).toBe(true)
    })

    test('does not mark status-push-sent or status-push-skipped as failures', () => {
      const decorated = decorateAuditLog([
        { action: 'status-push-sent', details: {} },
        { action: 'status-push-skipped', details: {} }
      ])
      expect(decorated[0].isFailure).toBe(false)
      expect(decorated[1].isFailure).toBe(false)
    })
  })
})

describe('notificationFailureDetected', () => {
  test('returns true when a notification-failed entry has no later notification-sent entry', () => {
    const auditLog = [
      {
        action: 'notification-failed',
        createdAt: '2026-04-27T10:00:00Z',
        details: { templateKey: 'Queried' }
      }
    ]
    expect(notificationFailureDetected(auditLog)).toBe(true)
  })

  test('returns false for a clean notification history (no failures)', () => {
    const auditLog = [
      {
        action: 'notification-sent',
        createdAt: '2026-04-27T10:00:00Z',
        details: { templateKey: 'SubmissionConfirmation' }
      },
      { action: 'task-completed', createdAt: '2026-04-27T10:05:00Z' }
    ]
    expect(notificationFailureDetected(auditLog)).toBe(false)
  })

  test('returns false when a later notification-sent entry for the SAME template resolves the failure', () => {
    // e.g. a resend of the same email type later succeeded.
    const auditLog = [
      {
        action: 'notification-failed',
        createdAt: '2026-04-27T10:00:00Z',
        details: { templateKey: 'SubmissionConfirmation' }
      },
      {
        action: 'notification-sent',
        createdAt: '2026-04-27T10:05:00Z',
        details: { templateKey: 'SubmissionConfirmation' }
      }
    ]
    expect(notificationFailureDetected(auditLog)).toBe(false)
  })

  test('returns true when a later notification-sent entry is for a DIFFERENT template (unrelated success does not resolve it)', () => {
    // A DulyMade email succeeding must not hide an unresolved Queried failure.
    const auditLog = [
      {
        action: 'notification-failed',
        createdAt: '2026-04-27T10:00:00Z',
        details: { templateKey: 'Queried' }
      },
      {
        action: 'notification-sent',
        createdAt: '2026-04-27T10:05:00Z',
        details: { templateKey: 'DulyMade' }
      }
    ]
    expect(notificationFailureDetected(auditLog)).toBe(true)
  })

  test('returns false when a later notification-sent entry has no templateKey (degrades to resolving any failure)', () => {
    const auditLog = [
      {
        action: 'notification-failed',
        createdAt: '2026-04-27T10:00:00Z',
        details: { templateKey: 'SubmissionConfirmation' }
      },
      {
        action: 'notification-sent',
        createdAt: '2026-04-27T10:05:00Z',
        details: {}
      }
    ]
    expect(notificationFailureDetected(auditLog)).toBe(false)
  })

  test('returns true when the notification-sent entry precedes the failure (still unresolved)', () => {
    const auditLog = [
      {
        action: 'notification-sent',
        createdAt: '2026-04-27T09:00:00Z',
        details: { templateKey: 'SubmissionConfirmation' }
      },
      {
        action: 'notification-failed',
        createdAt: '2026-04-27T10:00:00Z',
        details: { templateKey: 'Queried' }
      }
    ]
    expect(notificationFailureDetected(auditLog)).toBe(true)
  })

  test('returns false when auditLog is missing or not an array', () => {
    expect(notificationFailureDetected(undefined)).toBe(false)
    expect(notificationFailureDetected(null)).toBe(false)
    expect(notificationFailureDetected('not-an-array')).toBe(false)
  })

  test('returns false for an empty audit log', () => {
    expect(notificationFailureDetected([])).toBe(false)
  })

  // AC: "still retrying" is not a distinct audit state — the backend only
  // writes notification-failed once its own retry pipeline is exhausted.
  // notification-skipped (no operator email) is not a failure either.
  test('ignores notification-skipped entries', () => {
    const auditLog = [
      {
        action: 'notification-skipped',
        createdAt: '2026-04-27T10:00:00Z',
        details: { reason: 'missing-operator-email' }
      }
    ]
    expect(notificationFailureDetected(auditLog)).toBe(false)
  })
})

describe('determination-deadline audit entries (RA-572 follow-up)', () => {
  // `SlaService.AppendAuditEntry` stamps this exact shape. The action id is
  // the past-tense `sla-extended`, NOT the `sla-extend` transition id.
  const fullDetails = {
    reason: 'Operator asked for more time to supply the sampling plan.',
    actorUserId: 'user-1',
    beforeStartedAt: '2026-04-27T10:00:00.0000000Z',
    beforeTargetDuration: 'P84D',
    beforeBreached: 'False',
    afterStartedAt: '2026-04-27T10:00:00.0000000Z',
    afterTargetDuration: 'P114D',
    afterBreached: 'False',
    additionalDuration: 'P30D'
  }

  test('projects previous deadline, new deadline, actor and the reason for change', () => {
    expect(
      detailRowsForAuditEntry({
        action: 'sla-extended',
        createdBy: 'user-1',
        createdByName: 'Reg Ulator',
        details: fullDetails
      })
    ).toEqual([
      { key: 'Previous deadline', value: '20 July 2026' },
      { key: 'New deadline', value: '19 August 2026' },
      { key: 'Changed by', value: 'Reg Ulator' },
      {
        key: 'Reason for change',
        value: 'Operator asked for more time to supply the sampling plan.',
        multiline: true
      }
    ])
  })

  test('preserves a multi-line reason for paragraph-per-line rendering', () => {
    const reason = 'Line one.\n\nLine two.'
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      createdBy: 'user-1',
      details: { ...fullDetails, reason }
    })
    expect(rows).toContainEqual({
      key: 'Reason for change',
      value: reason,
      multiline: true
    })
  })

  test('normalises the CRLF line breaks a browser textarea submits to LF', () => {
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      createdBy: 'user-1',
      details: { ...fullDetails, reason: 'Line one.\r\nLine two.' }
    })
    expect(rows).toContainEqual({
      key: 'Reason for change',
      value: 'Line one.\nLine two.',
      multiline: true
    })
  })

  test('omits the reason row when the stored reason is only whitespace', () => {
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      createdBy: 'user-1',
      details: { ...fullDetails, reason: '   ' }
    })
    expect(rows.map((row) => row.key)).not.toContain('Reason for change')
  })

  test('falls back to createdBy when the entry carries no createdByName', () => {
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      createdBy: 'user-1',
      details: fullDetails
    })
    expect(rows).toContainEqual({ key: 'Changed by', value: 'user-1' })
  })

  test('omits every row an early-migration entry cannot supply', () => {
    // A sparse entry: no reason, no duration keys, no actor. Must render
    // nothing rather than throwing or emitting empty rows.
    expect(
      detailRowsForAuditEntry({
        action: 'sla-extended',
        details: {
          actorUserId: 'user-1',
          beforeStartedAt: '2026-04-27T10:00:00Z',
          afterStartedAt: '2026-04-27T10:00:00Z'
        }
      })
    ).toEqual([])
  })

  test('returns an empty array for an sla-extended entry with no details at all', () => {
    expect(detailRowsForAuditEntry({ action: 'sla-extended' })).toEqual([])
  })

  test('omits a deadline row whose snapshot is missing its startedAt half', () => {
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      createdByName: 'Reg Ulator',
      details: { ...fullDetails, beforeStartedAt: undefined }
    })
    expect(rows.map((row) => row.key)).toEqual([
      'New deadline',
      'Changed by',
      'Reason for change'
    ])
  })

  test.each([
    ['an unparseable startedAt', { beforeStartedAt: 'not-a-date' }],
    ['a non-string duration', { beforeTargetDuration: 84 }],
    ['a componentless duration', { beforeTargetDuration: 'PT' }],
    [
      'a calendar-month duration we refuse to guess at',
      {
        beforeTargetDuration: 'P2M'
      }
    ],
    ['a malformed duration', { beforeTargetDuration: '84 days' }]
  ])('omits the previous-deadline row for %s', (_label, override) => {
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      details: { ...fullDetails, ...override }
    })
    expect(rows.map((row) => row.key)).not.toContain('Previous deadline')
    expect(rows.map((row) => row.key)).toContain('New deadline')
  })

  test('adds a time-of-day duration onto the start to resolve the deadline', () => {
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      details: {
        ...fullDetails,
        beforeStartedAt: '2026-04-27T10:00:00Z',
        beforeTargetDuration: 'P83DT23H59M30S'
      }
    })
    expect(rows[0]).toEqual({ key: 'Previous deadline', value: '20 July 2026' })
  })

  test('handles a negative duration without inventing a row', () => {
    const rows = detailRowsForAuditEntry({
      action: 'sla-extended',
      details: { ...fullDetails, beforeTargetDuration: '-P1D' }
    })
    expect(rows[0]).toEqual({
      key: 'Previous deadline',
      value: '26 April 2026'
    })
  })

  test('whole entries decorate with the backend-supplied heading untouched', () => {
    const [decorated] = decorateAuditLog([
      {
        id: 'cccc3333-cccc-cccc-cccc-cccccccccccc',
        action: 'sla-extended',
        actionDisplayName: 'Determination deadline extended',
        createdAt: '2026-05-01T09:00:00Z',
        createdBy: 'user-1',
        createdByName: 'Reg Ulator',
        details: fullDetails
      }
    ])
    expect(decorated.summary).toBe('')
    expect(decorated.isFailure).toBe(false)
    expect(decorated.detailRows).toContainEqual({
      key: 'Reason for change',
      value: fullDetails.reason,
      multiline: true
    })
  })
})
