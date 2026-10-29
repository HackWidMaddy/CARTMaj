/**
 * Turning Subdomain Discovery off warns about what it costs, in the scope's own
 * terms: a batch counts its enumerated scope groups (a covered wildcard is not a
 * second group), and a single domain names the target that becomes the only scan.
 *
 * Run: npx vitest run src/components/projects/ProjectForm/sections/SubdomainDiscoverySection.test.tsx
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SubdomainDiscoverySection } from './SubdomainDiscoverySection'

const confirm = vi.fn(async (_message: string, _title?: string) => false)
vi.mock('@/components/ui', async (orig) => ({
  ...(await orig<typeof import('@/components/ui')>()),
  useAlertModal: () => ({ confirm }),
}))
vi.mock('../RegistryFields', () => ({ RegistryFields: () => null }))

afterEach(() => { cleanup(); confirm.mockClear() })

const BASE = {
  targetDomain: '', subdomainList: [] as string[], ipMode: false,
  domainBatchMode: false, domainBatchHosts: [] as string[], subdomainDiscoveryEnabled: true,
}

async function turnOff(data: Partial<typeof BASE>) {
  render(<SubdomainDiscoverySection data={{ ...BASE, ...data } as never} updateField={vi.fn() as never} />)
  fireEvent.click(screen.getAllByRole('switch')[0])
  await waitFor(() => expect(confirm).toHaveBeenCalled())
  return confirm.mock.calls[0][0]
}

describe('turning Subdomain Discovery off', () => {
  test('a batch counts its enumerated scope groups and names them', async () => {
    const message = await turnOff({
      domainBatchMode: true, domainBatchHosts: ['*.example.com', 'www.example.com', '*.acme.co.uk', '*.co.uk'],
    })
    expect(message).toContain('2 scope groups are set to be fully enumerated (*.example.com, *.acme.co.uk)')
  })

  test('a single domain names the target that becomes the only scan', async () => {
    const message = await turnOff({ targetDomain: 'api.example.com' })
    expect(message).toContain('api.example.com itself becomes the only scan target')
  })
})
