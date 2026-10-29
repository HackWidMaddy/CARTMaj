/**
 * WEB-16: an org whose apex was no target has no apex records to read, so the
 * DNS posture says "not resolved (apex not in scope)" instead of "missing".
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { DnsEmailTable } from './DnsEmailTable'

function row(domain: string, apexResolved: boolean) {
  return {
    nodeId: null, domain, apexResolved,
    apexNote: apexResolved ? null : 'not resolved (apex not in scope)',
    spfPresent: apexResolved ? true : null, spfStrict: apexResolved ? true : null, spfRecord: null,
    dmarcPresent: apexResolved ? true : null, dmarcPolicy: null, dnssec: null, dnssecEnabled: false,
    zoneTransferOpen: false, mxRecords: [], mxCount: 0, nameServers: [], nameServerCount: 0,
    nsDistinctProviders: 0, whoisEmails: [], registrar: null,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return createElement(QueryClientProvider, { client }, children)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('DNS posture of an org whose apex was no target', () => {
  test('says not resolved, not missing', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.startsWith('/api/analytics/redzone/dnsEmail')) {
        return new Response(JSON.stringify({ rows: [row('example.com', false), row('other.test', true)], meta: {} }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    render(createElement(DnsEmailTable, { projectId: 'p1' }), { wrapper })
    // In the SPF and the DMARC cell of that org's row only.
    const notes = await screen.findAllByTestId('dns-apex-note')
    expect(notes.map(n => n.textContent)).toEqual(['not resolved (apex not in scope)', 'not resolved (apex not in scope)'])
  })
})
