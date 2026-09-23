import { vi } from 'vitest'

import { createServer } from '#/server/server.js'
import { statusCodes } from '#/server/common/constants/status-codes.js'
import {
  clearWorkItemRegistry,
  registerWorkItemType
} from '#/server/work-items/core/registry.js'

vi.mock('#/server/common/helpers/backend-api/backend-api.js', () => ({
  getReAccreditationPriorYear: vi.fn(),
  assignWorkItem: vi.fn(),
  unassignWorkItem: vi.fn(),
  getBackendHealth: vi.fn(),
  raiseWorkItemQuery: vi.fn(),
  getWorkItem: vi.fn(),
  getWorkItems: vi.fn(),
  completeWorkItemTask: vi.fn(),
  setWorkItemTaskStatus: vi.fn(),
  applyWorkItemAction: vi.fn(),
  addWorkItemNote: vi.fn(),
  updateRecyclingOperations: vi.fn()
}))

const { getWorkItem } =
  await import('#/server/common/helpers/backend-api/backend-api.js')

const ID = '11111111-1111-1111-1111-111111111111'

function aWorkItem(overrides = {}) {
  return {
    id: ID,
    typeId: 're-accreditation',
    stateId: 'submitted',
    submittedAt: '2026-04-27T10:00:00Z',
    lastModifiedAt: '2026-04-27T10:05:00Z',
    submittedBy: 'frontend',
    templateVersion: 'v1',
    payload: {
      applicantName: 'Acme',
      applicationReference: 'RA-000000001'
    },
    availableActions: [],
    auditLog: [],
    ...overrides
  }
}

function registerReaccreditation() {
  registerWorkItemType({
    id: 're-accreditation',
    displayName: 'Re-accreditation',
    initialState: { id: 'submitted', displayName: 'Submitted' },
    states: [
      { id: 'submitted', displayName: 'Submitted' },
      { id: 'approved', displayName: 'Approved', isTerminal: true }
    ],
    getTasksForState: () => []
  })
}

describe('#workItemAuditLogController', () => {
  let server

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(() => {
    getWorkItem.mockReset()
    clearWorkItemRegistry()
  })

  test('Renders the audit log page with entries in reverse-chronological (newest-first) order, action, actor and timestamp', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        // Backend projects newest-first (RA-568); the mock reflects that
        // wire order since the controller does not re-sort.
        auditLog: [
          {
            id: 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            action: 'action-applied',
            actionDisplayName: 'Action applied',
            details: {
              actionId: 'approve',
              actionDisplayName: 'Approve',
              fromStateId: 'submitted',
              toStateId: 'approved'
            },
            createdAt: '2026-04-27T10:00:00Z',
            createdBy: 'bob-2',
            createdByName: 'Bob Example'
          },
          {
            id: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            action: 'note-added',
            actionDisplayName: 'Note added',
            details: {
              noteText: 'Checked eligibility'
            },
            createdAt: '2026-04-27T09:00:00Z',
            createdBy: 'alice-1',
            createdByName: 'Alice Example'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    expect(getWorkItem).toHaveBeenCalledWith({
      workItemId: ID,
      user: expect.objectContaining({ id: expect.any(String) })
    })
    // RA-295: the audit log is the "Application history" tab of the
    // individual work item page.
    expect(result).toEqual(expect.stringContaining('Application history'))
    expect(result).toEqual(
      expect.stringContaining('data-testid="tab-application-history"')
    )
    expect(result).toEqual(expect.stringContaining('Note added'))
    expect(result).toEqual(expect.stringContaining('Checked eligibility'))
    expect(result).toEqual(expect.stringContaining('Action applied'))
    expect(result).toEqual(
      expect.stringContaining('Approve (submitted → approved)')
    )
    expect(result).toEqual(expect.stringContaining('Alice Example'))
    expect(result).toEqual(expect.stringContaining('Bob Example'))
    // Timestamps render in UK local time (BST in April, so 09:00Z -> 10:00am)
    // via the formatDateTimeGds filter, not as the raw UTC ISO string.
    expect(result).toEqual(expect.stringContaining('27 April 2026 at 10:00am'))
    // Reverse-chronological (newest-first) ordering: the later entry
    // appears before the earlier one in the rendered HTML.
    expect(result.indexOf('Action applied')).toBeLessThan(
      result.indexOf('Note added')
    )
    // Provides a way back to the detail page.
    expect(result).toEqual(expect.stringContaining(`/work-items/${ID}`))
  })

  test('Renders an empty audit log message when no entries exist', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({ auditLog: [] })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    expect(result).toEqual(
      expect.stringContaining(
        'No actions have been recorded against this work item yet.'
      )
    )
  })

  // RA-196 / RA-295: the case header shows the application reference when
  // present in the payload; the summary tab link keeps the internal id.
  test('Shows the application reference in the case header, keeping the id in the tab href', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        payload: { applicationReference: 'RA-555000111' }
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    expect(result).toMatch(
      /data-testid="case-header-accreditation-ref">RA-555000111</
    )
    expect(result).not.toEqual(expect.stringContaining(`Work item ${ID}`))
    expect(result).toEqual(expect.stringContaining(`/work-items/${ID}`))
    // The case header's own back link replaces the GOV.UK breadcrumbs.
    expect(result).toEqual(
      expect.stringContaining('data-testid="case-header-applications-link"')
    )
  })

  test('Exposes the body of a note-added entry inside a "Show details" disclosure, preserving line breaks and escaping HTML', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        auditLog: [
          {
            id: 'cccc3333-cccc-cccc-cccc-cccccccccccc',
            action: 'note-added',
            actionDisplayName: 'Note added',
            details: {
              noteId: 'n-1',
              noteText: 'First line\nSecond <script>evil</script>'
            },
            createdAt: '2026-04-27T09:00:00Z',
            createdBy: 'alice-1',
            createdByName: 'Alice Example'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    // Disclosure wrapper rather than the note rendered inline — keeps
    // the timeline scannable when entries carry long detail bodies.
    expect(result).toEqual(
      expect.stringContaining('data-testid="work-item-audit-entry-details"')
    )
    expect(result).toEqual(expect.stringContaining('Show details'))
    expect(result).toEqual(expect.stringContaining('Note'))
    expect(result).toEqual(expect.stringContaining('First line'))
    // Each newline becomes its own paragraph rather than collapsing into
    // a single run of text.
    expect(result).not.toEqual(expect.stringContaining('First line\nSecond'))
    // HTML in the note body is escaped — never rendered as live markup.
    expect(result).toEqual(
      expect.stringContaining('Second &lt;script&gt;evil&lt;/script&gt;')
    )
    expect(result).not.toEqual(expect.stringContaining('<script>evil</script>'))
  })

  test('Shows snapshot context rows even for unknown action entries with no action-specific detail rows', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        auditLog: [
          {
            id: 'eeee5555-eeee-eeee-eeee-eeeeeeeeeeee',
            action: 'something-else',
            actionDisplayName: 'Something else',
            details: {},
            createdAt: '2026-04-27T09:00:00Z'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    expect(result).toEqual(
      expect.stringContaining('data-testid="work-item-audit-entry-details"')
    )
    expect(result).toEqual(expect.stringContaining('Show details'))
    expect(result).toEqual(expect.stringContaining('Assigned to'))
  })

  test('Renders each entry State row from the entry OWN stateId, not the current work-item state (epr-rr9s)', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      // Current state is "Approved", but the early "assigned" entry
      // happened while the item was still "Submitted".
      workItem: aWorkItem({
        stateId: 'approved',
        auditLog: [
          {
            id: 'aaaa9999-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            action: 'assigned',
            actionDisplayName: 'Assigned',
            stateId: 'submitted',
            details: { assigneeName: 'Bob Barker' },
            createdAt: '2026-04-27T08:30:00Z'
          },
          {
            id: 'bbbb0000-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            action: 'note-added',
            actionDisplayName: 'Note added',
            // Old-document entry: no stateId — its State row is omitted.
            details: { noteText: 'Looks fine' },
            createdAt: '2026-04-27T09:30:00Z'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    // The assigned entry's disclosure shows the historical state display
    // name ("Submitted"), resolved via the type's state definitions.
    expect(result).toEqual(expect.stringContaining('Submitted'))
    // The note-added entry has no stateId; scope to its <li> and assert no
    // State row leaked the current ("Approved") state into it.
    const noteEntry = result.slice(
      result.indexOf(
        'data-testid="work-item-audit-entry-bbbb0000-bbbb-bbbb-bbbb-bbbbbbbbbbbb"'
      ),
      result.indexOf('Back to work item')
    )
    expect(noteEntry).not.toEqual(expect.stringContaining('Approved'))
  })

  test('Surfaces the work item payload on the submitted audit entry (RA-186)', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        payload: { applicantName: 'Acme', siteId: 'site-1' },
        auditLog: [
          {
            id: 'ffff6666-ffff-ffff-ffff-ffffffffffff',
            action: 'work-item-submitted',
            actionDisplayName: 'Work item submitted',
            details: { typeId: 're-accreditation', stateId: 'submitted' },
            createdAt: '2026-04-27T08:00:00Z',
            createdBy: 'frontend',
            createdByName: 'Acme submission'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    // Payload now lives inside the submitted entry's disclosure rather
    // than as a separate panel on the detail page.
    expect(result).toEqual(
      expect.stringContaining('data-testid="work-item-audit-entry-details"')
    )
    expect(result).toEqual(expect.stringContaining('Payload'))
    expect(result).toEqual(expect.stringContaining('applicantName'))
    expect(result).toEqual(expect.stringContaining('Acme'))
    expect(result).toEqual(expect.stringContaining('site-1'))
    // Rendered inside a <pre><code> block so the indentation in the
    // formatted JSON is preserved (RA-186 follow-up — paragraph-per-
    // line collapses leading whitespace and looked broken).
    expect(result).toEqual(
      expect.stringContaining('data-testid="work-item-audit-entry-detail-pre"')
    )
    // Entry <li> carries a data-action attribute so e2e tests can
    // scope assertions to a specific entry without relying on its id.
    expect(result).toEqual(
      expect.stringContaining('data-action="work-item-submitted"')
    )
    // Template version is no longer surfaced anywhere on the audit log.
    expect(result).not.toEqual(expect.stringContaining('Template version'))
  })

  test('Surfaces the action, states and error on a status-push-failed entry inside a "Show details" disclosure (RA-368)', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        auditLog: [
          {
            id: 'gggg7777-gggg-gggg-gggg-gggggggggggg',
            action: 'status-push-failed',
            actionDisplayName:
              'Status failed to send to the Registration & Accreditation service',
            details: {
              actionId: 'approve',
              actionDisplayName: 'Approve',
              fromStateId: 'awaiting-decision',
              toStateId: 'approved',
              toStateDisplayName: 'Approved',
              errorMessage: 'Registration & Accreditation service returned 500'
            },
            createdAt: '2026-04-27T09:00:00Z'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    expect(result).toEqual(
      expect.stringContaining(
        'Status failed to send to the Registration &amp; Accreditation service'
      )
    )
    expect(result).toEqual(
      expect.stringContaining('data-testid="work-item-audit-entry-details"')
    )
    expect(result).toEqual(expect.stringContaining('Show details'))
    expect(result).toEqual(expect.stringContaining('Approve'))
    expect(result).toEqual(expect.stringContaining('awaiting-decision'))
    expect(result).toEqual(expect.stringContaining('Approved'))
    expect(result).toEqual(
      expect.stringContaining(
        'Registration &amp; Accreditation service returned 500'
      )
    )
    expect(result).toEqual(
      expect.stringContaining('data-action="status-push-failed"')
    )
  })

  // RA-450: the "Org ID" snapshot row must show the operator organisation
  // id, not the application reference (the old, wrong mapping).
  test('Shows the operator organisation id (not the application reference) in the Org ID snapshot row', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        payload: {
          applicantName: 'Acme',
          applicationReference: 'AP27EA5CB21WO2',
          // RA-503: operatorOrgNumber is the operator/regulator-safe value; see
          // case-header.test.js's dedicated "organisation id resolution" tests for the
          // ObjectId-vs-6-digit shape-detection fallback coverage.
          operatorOrgNumber: 999999
        },
        auditLog: [
          {
            id: 'aaaa9999-bbbb-cccc-dddd-eeeeeeeeeeee',
            action: 'action-applied',
            actionDisplayName: 'Routed to nation',
            details: { actionId: 'route-to-nation' },
            createdAt: '2026-04-27T09:00:00Z'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    // Scope to the Org ID row's value cell so we assert on the row itself,
    // not on the application reference that legitimately appears in the
    // case header elsewhere on the page.
    const orgIdCell = result
      .slice(result.indexOf('Org ID</dt>'))
      .match(/Org ID<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)
    expect(orgIdCell).not.toBeNull()
    expect(orgIdCell[1]).toContain('999999')
    expect(orgIdCell[1]).not.toContain('AP27EA5CB21WO2')
  })

  // RA-450 AC2: when the org id is genuinely absent, the Org ID row is
  // omitted entirely rather than rendered blank.
  test('Omits the Org ID row when operatorOrganisationId is absent', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        payload: {
          applicantName: 'Acme',
          applicationReference: 'AP27EA5CB21WO2'
        },
        auditLog: [
          {
            id: 'bbbb0000-cccc-dddd-eeee-ffffffffffff',
            action: 'action-applied',
            actionDisplayName: 'Routed to nation',
            details: { actionId: 'route-to-nation' },
            createdAt: '2026-04-27T09:00:00Z'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    expect(result).not.toContain('Org ID</dt>')
  })

  test('Renders 404 page when the backend reports no such work item', async () => {
    getWorkItem.mockResolvedValue({ ok: false, status: 404 })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.notFound)
    expect(result).toEqual(expect.stringContaining('Application not found'))
    // RA-358 AC2. The breadcrumb must speak the same vocabulary as the
    // heading and the back link, all three of which point at /work-items.
    // Scoped to the breadcrumb class: the header nav also renders a
    // "Work items" link, so a bare substring check would be ambiguous.
    expect(result).toContain(
      '<a class="govuk-breadcrumbs__link" href="/work-items">Applications</a>'
    )
  })

  test('Renders 502 page when the backend cannot be reached', async () => {
    getWorkItem.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.badGateway)
    expect(result).toEqual(expect.stringContaining('Work item unavailable'))
    expect(result).toEqual(expect.stringContaining('ECONNREFUSED'))
  })

  // RA-572 follow-up. QA reported the mandatory "Reason for change" the
  // regulator supplies when changing a determination deadline never reached
  // the Application history. The backend always persisted it on the
  // `sla-extended` entry's `details`; `detailRowsForAuditEntry` simply had no
  // case for that action, so the disclosure fell through to the generic
  // work-item snapshot. Deliberately does NOT assert the entry heading text —
  // that string is being changed on a separate branch.
  test('Shows the reason for change and both deadlines for an sla-extended entry', async () => {
    registerReaccreditation()
    getWorkItem.mockResolvedValue({
      ok: true,
      workItem: aWorkItem({
        auditLog: [
          {
            id: 'dddd4444-dddd-dddd-dddd-dddddddddddd',
            action: 'sla-extended',
            actionDisplayName: 'Determination deadline extended',
            details: {
              reason: 'Operator needs longer.\nAgreed on the call.',
              actorUserId: 'alice-1',
              beforeStartedAt: '2026-04-27T10:00:00.0000000Z',
              beforeTargetDuration: 'P84D',
              beforeBreached: 'False',
              afterStartedAt: '2026-04-27T10:00:00.0000000Z',
              afterTargetDuration: 'P114D',
              afterBreached: 'False',
              additionalDuration: 'P30D'
            },
            createdAt: '2026-05-01T09:00:00Z',
            createdBy: 'alice-1',
            createdByName: 'Alice Example'
          }
        ]
      })
    })

    const { statusCode, result } = await server.inject({
      method: 'GET',
      url: `/work-items/${ID}/audit-log`
    })

    expect(statusCode).toBe(statusCodes.ok)
    expect(result).toEqual(
      expect.stringContaining('data-testid="work-item-audit-entry-details"')
    )
    expect(result).toEqual(expect.stringContaining('Reason for change'))
    expect(result).toEqual(expect.stringContaining('Operator needs longer.'))
    expect(result).toEqual(expect.stringContaining('Agreed on the call.'))
    // Multi-line reasons render paragraph-per-line, not as one run-on line,
    // and never inside the monospace <pre> reserved for JSON payloads.
    expect(result).not.toEqual(
      expect.stringContaining('Operator needs longer.\nAgreed')
    )
    expect(result).not.toEqual(
      expect.stringContaining('data-testid="work-item-audit-entry-detail-pre"')
    )
    // The ISO durations are resolved into the dates they represent; the raw
    // values never reach the page.
    expect(result).toEqual(expect.stringContaining('Previous deadline'))
    expect(result).toEqual(expect.stringContaining('20 July 2026'))
    expect(result).toEqual(expect.stringContaining('New deadline'))
    expect(result).toEqual(expect.stringContaining('19 August 2026'))
    expect(result).not.toEqual(expect.stringContaining('P114D'))
    expect(result).not.toEqual(expect.stringContaining('P30D'))
    expect(result).toEqual(expect.stringContaining('Changed by'))
  })
})
