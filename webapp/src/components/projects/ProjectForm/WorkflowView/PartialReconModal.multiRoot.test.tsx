/**
 * @vitest-environment jsdom
 *
 * The partial-recon modal on a project with several roots (Domain batch).
 *
 * The modal used to validate every custom input against ONE root and send
 * `graph_inputs: { domain }`, so a subdomain of the second root was rejected and
 * only one root was ever scanned. It now validates against any root, sends
 * `graph_inputs: { domains }`, says which Domain nodes are stale or have no data,
 * and lets SubdomainDiscovery pick among the roots allowed to enumerate.
 *
 * Fixture roots are alpha.test / beta.test / gamma.test only.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/providers/ProjectProvider', async orig => ({
  ...(await orig<typeof import('@/providers/ProjectProvider')>()),
  useProject: () => ({ userId: 'u1' }),
  useOptionalProject: () => ({ userId: 'u1' }),
}))

import { PartialReconModal } from './PartialReconModal'

const ROOTS = ['alpha.test', 'beta.test', 'gamma.test']

let graphInputs: Record<string, unknown> | 'error' = {}
// The saved project's scopeGroups (GET /api/projects/[id]); none = an older webapp.
let projectRow: Record<string, unknown> = {}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/graph-inputs/')) {
      if (graphInputs === 'error') return Promise.reject(new Error('network down'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(graphInputs) } as Response)
    }
    if (url === '/api/projects/p1') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(projectRow) } as Response)
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
  }))
}

function renderModal(toolId: string, onConfirm = vi.fn(), projectRoots = ROOTS) {
  const view = render(
    <PartialReconModal
      isOpen
      toolId={toolId}
      onClose={vi.fn()}
      onConfirm={onConfirm}
      projectId="p1"
      projectRoots={projectRoots}
      userId="u1"
    />,
  )
  return { ...view, onConfirm }
}

/** The modal renders through a portal, so its fields live under document.body. */
function textareas() {
  return Array.from(document.body.querySelectorAll('textarea'))
}

async function runButton() {
  return (await screen.findByRole('button', { name: /Run Partial Recon/i })) as HTMLButtonElement
}

afterEach(cleanup)
beforeEach(() => {
  projectRow = {}
  graphInputs = {
    domain: 'alpha.test', domains: ROOTS, stale_domains: [], empty_domains: [],
    existing_subdomains: ['www.alpha.test', 'api.beta.test'], existing_subdomains_count: 2,
    existing_ips_count: 4, existing_ports_count: 6, source: 'graph',
  }
  stubFetch()
})

describe('custom inputs are validated against every root', () => {
  test('a subdomain of the second root is accepted', async () => {
    renderModal('Naabu')
    await screen.findByTestId('partial-recon-roots')
    fireEvent.change(textareas()[0], { target: { value: 'www.beta.test' } })
    expect(screen.queryByText(/out of scope for this run/)).toBeNull()
    expect((await runButton()).disabled).toBe(false)
  })

  test('a host under no root is still refused', async () => {
    renderModal('Naabu')
    await screen.findByTestId('partial-recon-roots')
    fireEvent.change(textareas()[0], { target: { value: 'www.other.test' } })
    expect(await screen.findByText(/www\.other\.test is out of scope for this run \(under alpha\.test, beta\.test, gamma\.test\)/)).toBeTruthy()
    expect((await runButton()).disabled).toBe(true)
  })

  test('a URL on the third root is accepted', async () => {
    renderModal('Katana')
    await screen.findByTestId('partial-recon-roots')
    const fields = textareas()
    fireEvent.change(fields[fields.length - 1], { target: { value: 'https://shop.gamma.test/cart' } })
    expect(screen.queryByText(/out of scope/)).toBeNull()
  })
})

describe('the saved scope groups decide (§4.6, the rule the server applies)', () => {
  const group = (scanRoot: string, mode: 'exact' | 'enumerate', includeRoot: boolean, exactHosts: string[] = []) =>
    ({ scanRoot, orgDomain: scanRoot, mode, includeRoot, exactHosts, entries: [], notes: [] })

  beforeEach(() => {
    projectRow = { scopeGroups: [
      group('alpha.test', 'exact', false, ['www.alpha.test']),
      group('beta.test', 'enumerate', false),
      group('gamma.test', 'enumerate', true),
    ] }
  })

  async function typeHost(host: string) {
    renderModal('Naabu')
    await screen.findByTestId('partial-recon-roots')
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/projects/p1'))
    fireEvent.change(textareas()[0], { target: { value: host } })
  }

  test('a listed group admits only its hosts', async () => {
    await typeHost('mail.alpha.test')
    expect(await screen.findByText(/mail\.alpha\.test is out of scope for this run \(alpha\.test: www \(listed\)/)).toBeTruthy()
  })

  test('an enumerated root is no target without Root', async () => {
    await typeHost('beta.test')
    expect(await screen.findByText(/beta\.test is out of scope for this run/)).toBeTruthy()
  })

  test('hosts the groups admit pass', async () => {
    for (const host of ['www.alpha.test', 'x.beta.test', 'gamma.test']) {
      cleanup()
      await typeHost(host)
      expect(screen.queryByText(/out of scope for this run/)).toBeNull()
    }
  })
})

describe('what Run sends', () => {
  test('the roots, as graph_inputs.domains', async () => {
    const { onConfirm } = renderModal('Tlsx')
    await screen.findByTestId('partial-recon-roots')
    fireEvent.click(await runButton())
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      tool_id: 'Tlsx', graph_inputs: { domains: ROOTS },
    }))
  })

  // A tool with no custom-input fields submits through a second branch of
  // handleRun; the per-domain lookups (Urlscan, Uncover) are among them.
  test.each(['Urlscan', 'Uncover'])('%s (no custom inputs) sends every root too', async (toolId) => {
    const { onConfirm } = renderModal(toolId)
    await screen.findByTestId('partial-recon-roots')
    fireEvent.click(await runButton())
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      tool_id: toolId, graph_inputs: { domains: ROOTS },
    }))
  })

  test('no roots, no run', async () => {
    graphInputs = { domain: null, domains: [], existing_subdomains_count: 0, source: 'graph' }
    renderModal('Shodan')
    expect(await screen.findByText(/No scan root/)).toBeTruthy()
    expect((await runButton()).disabled).toBe(true)
  })
})

describe('the fetch-error fallback still shows the roots', () => {
  test('a fetch error falls back to every root the form holds', async () => {
    graphInputs = 'error'
    const { onConfirm } = renderModal('Tlsx')
    const summary = await screen.findByTestId('partial-recon-roots')
    expect(summary.textContent).toContain('alpha.test, beta.test, gamma.test')
    fireEvent.click(await runButton())
    expect(onConfirm.mock.calls[0][0].graph_inputs).toEqual({ domains: ROOTS })
  })

  test('the fallback sorts the form roots', async () => {
    graphInputs = 'error'
    renderModal('Tlsx', vi.fn(), ['gamma.test', 'alpha.test'])
    const summary = await screen.findByTestId('partial-recon-roots')
    expect(summary.textContent).toContain('alpha.test, gamma.test')
  })
})

describe('the notes and the summary', () => {
  test('stale Domain nodes are named and said not to be scanned', async () => {
    graphInputs = { ...(graphInputs as object), stale_domains: ['old.test'] }
    renderModal('Tlsx')
    const note = await screen.findByTestId('partial-recon-stale')
    expect(note.textContent).toMatch(/old\.test.*no longer a scan root of this project, not scanned; the next full recon removes it/)
  })

  test('roots without recon data are named', async () => {
    graphInputs = { ...(graphInputs as object), empty_domains: ['gamma.test'] }
    renderModal('Tlsx')
    expect((await screen.findByTestId('partial-recon-empty')).textContent).toMatch(/gamma\.test.*no recon data yet/)
  })

  test('more than three roots collapse behind a toggle', async () => {
    const five = ['a1.test', 'a2.test', 'a3.test', 'a4.test', 'a5.test']
    graphInputs = { ...(graphInputs as object), domain: 'a1.test', domains: five }
    renderModal('Tlsx')
    const summary = await screen.findByTestId('partial-recon-roots')
    expect(summary.textContent).toContain('a1.test, a2.test, a3.test')
    expect(summary.textContent).not.toContain('a4.test')
    fireEvent.click(screen.getByRole('button', { name: '+2 more' }))
    expect(summary.textContent).toContain('a5.test')
  })
})

describe('SubdomainDiscovery picks among the roots allowed to enumerate', () => {
  beforeEach(() => {
    graphInputs = { ...(graphInputs as object), discovery_domains: ['beta.test', 'gamma.test'] }
  })

  test('a literal root is listed but cannot be ticked', async () => {
    renderModal('SubdomainDiscovery')
    const list = await screen.findByTestId('partial-recon-discovery-list')
    const boxes = Array.from(list.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[]
    expect(boxes.map(b => [b.disabled, b.checked])).toEqual([[true, false], [false, true], [false, true]])
    expect(list.textContent).toContain('listed hosts only')
  })

  test('only the ticked roots are sent', async () => {
    const { onConfirm } = renderModal('SubdomainDiscovery')
    const list = await screen.findByTestId('partial-recon-discovery-list')
    fireEvent.click(list.querySelectorAll('input[type=checkbox]')[1])
    fireEvent.click(await runButton())
    expect(onConfirm.mock.calls[0][0].graph_inputs).toEqual({ domains: ['gamma.test'] })
  })

  test('nothing ticked, no run', async () => {
    renderModal('SubdomainDiscovery')
    const list = await screen.findByTestId('partial-recon-discovery-list')
    fireEvent.click(list.querySelectorAll('input[type=checkbox]')[1])
    fireEvent.click(list.querySelectorAll('input[type=checkbox]')[2])
    await waitFor(async () => expect((await runButton()).disabled).toBe(true))
    expect(screen.getByText(/Tick at least one scan root/)).toBeTruthy()
  })

  test('a batch with no wildcard says why nothing can run', async () => {
    graphInputs = { ...(graphInputs as object), discovery_domains: [] }
    renderModal('SubdomainDiscovery')
    expect(await screen.findByText(/No scan root in this project may be enumerated/)).toBeTruthy()
    expect((await runButton()).disabled).toBe(true)
  })

  test('the list scrolls rather than growing without bound', async () => {
    renderModal('SubdomainDiscovery')
    const list = await screen.findByTestId('partial-recon-discovery-list')
    expect(list.style.overflowY).toBe('auto')
    expect(list.style.maxHeight).not.toBe('')
  })
})

describe('settings overrides', () => {
  test('the Nuclei checkboxes send only keys the orchestrator allows', async () => {
    const { PARTIAL_RECON_OVERRIDE_KEYS } = await import('@/lib/recon-types')
    const { onConfirm } = renderModal('Nuclei')
    await screen.findByTestId('partial-recon-roots')
    fireEvent.click(await runButton())
    const sent = Object.keys(onConfirm.mock.calls[0][0].settings_overrides ?? {})
    expect(sent.length).toBeGreaterThan(0)
    for (const key of sent) expect(PARTIAL_RECON_OVERRIDE_KEYS).toContain(key)
  })
})

describe('an old-model graph (§4.11.6)', () => {
  test('shows the banner, names the old Domain nodes, and disables Run', async () => {
    graphInputs = { ...(graphInputs as Record<string, unknown>), legacy_graph: ['co.uk'] }
    renderModal('Naabu')
    const banner = await screen.findByTestId('partial-recon-legacy-graph')
    expect(banner.textContent).toMatch(/built before the current scope model/)
    expect(banner.textContent).toContain('co.uk')
    expect(banner.textContent).toMatch(/Run a full recon first/)
    expect((await runButton()).disabled).toBe(true)
  })

  test('a current graph shows no banner and leaves Run enabled', async () => {
    renderModal('Naabu')
    await waitFor(async () => expect((await runButton()).disabled).toBe(false))
    expect(screen.queryByTestId('partial-recon-legacy-graph')).toBeNull()
  })
})
