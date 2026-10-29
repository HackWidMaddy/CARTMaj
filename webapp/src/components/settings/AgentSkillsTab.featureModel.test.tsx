/**
 * Generate with AI in Global Settings' Edit dialog (D11): it reads the skill's stored text,
 * asks the "Skill names & descriptions" model for the empty fields only, fills only what is
 * still empty, and never saves; Save stays the only write.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { AlertProvider, ToastProvider } from '@/components/ui'
import { GATE_USER, jsonResponse, pickInGate, stubGateFetch } from '@/components/shared/featureModelGate.testUtils'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: GATE_USER }) }))

import { FeatureModelGateProvider } from '@/components/shared/FeatureModelGate'
import { AgentSkillsTab } from './AgentSkillsTab'
import { featureModelMessage } from '@/lib/llmFeatures'

const LIST_URL = `/api/users/${GATE_USER}/attack-skills`
const GENERATE_URL = `${LIST_URL}/generate-metadata`
const SKILL = { id: 'sk1', name: 'Old Pickle Notes', description: null, createdAt: '2026-10-10T10:00:00.000Z', pendingChangeSetIds: [] }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function route(generate: (body: { items: { key: string; fields: string[]; content: string; name: string; fileName: string }[] }) => Response) {
  return (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === LIST_URL && method === 'GET') return jsonResponse(200, [SKILL])
    if (url === `${LIST_URL}/sk1` && method === 'GET') return jsonResponse(200, { ...SKILL, content: '# Pickle\n\nThe stored text.' })
    if (url.startsWith(`${LIST_URL}/name-check`)) return jsonResponse(200, { available: true, normalized: 'x', suggestion: null })
    if (url === GENERATE_URL && method === 'POST') return generate(JSON.parse(init!.body as string))
    return jsonResponse(404, {})
  }
}

const answer = (body: { items: { key: string; fields: string[] }[] }) => jsonResponse(200, {
  items: body.items.map((i) => ({
    key: i.key,
    ...(i.fields.includes('name') ? { name: 'AI Name' } : {}),
    ...(i.fields.includes('description') ? { description: 'Tests Python pickle deserialization.' } : {}),
  })),
  modelUsed: 'claude-haiku-4-5',
})

async function openEdit() {
  render(
    <ToastProvider>
      <AlertProvider>
        <FeatureModelGateProvider>
          <AgentSkillsTab userId={GATE_USER} />
        </FeatureModelGateProvider>
      </AlertProvider>
    </ToastProvider>,
  )
  fireEvent.click(within(await screen.findByTestId('user-skill-sk1')).getByTitle('Edit name and description'))
  await screen.findByRole('heading', { name: 'Edit Skill' })
}

const generateButton = () => screen.getByRole('button', { name: 'Generate with AI' })
const description = () => screen.getByLabelText('Description') as HTMLTextAreaElement

describe('Generate with AI in the Edit dialog', () => {
  test('without a saved model the gate opens; the request carries one item with the stored text', async () => {
    const stub = stubGateFetch({}, route(answer))
    await openEdit()
    fireEvent.click(generateButton())
    await pickInGate('Claude Haiku 4.5')
    await waitFor(() => expect(description().value).toBe('Tests Python pickle deserialization.'))
    const calls = stub.calls(GENERATE_URL, 'POST')
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0][1]!.body as string)).toEqual({
      items: [{ key: 'sk1', fileName: '', content: '# Pickle\n\nThe stored text.', name: 'Old Pickle Notes', fields: ['description'] }],
    })
    expect(stub.saved).toEqual({ skill_metadata: 'claude-haiku-4-5' })
  })

  test('only the empty description is filled, and nothing is saved until Save', async () => {
    const stub = stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route(answer))
    await openEdit()
    fireEvent.click(generateButton())
    await waitFor(() => expect(description().value).toBe('Tests Python pickle deserialization.'))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Old Pickle Notes')
    expect(stub.calls(`${LIST_URL}/sk1`, 'PUT')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(stub.calls(`${LIST_URL}/sk1`, 'PUT')).toHaveLength(1))
    expect(JSON.parse(stub.calls(`${LIST_URL}/sk1`, 'PUT')[0][1]!.body as string)).toEqual({
      name: 'Old Pickle Notes', description: 'Tests Python pickle deserialization.',
    })
  })

  test('a 504 shows its message', async () => {
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route(() => jsonResponse(504, {
      error: 'x', code: 'agent_timeout', featureId: 'skill_metadata',
    })))
    await openEdit()
    fireEvent.click(generateButton())
    expect(await screen.findByText(featureModelMessage('agent_timeout'))).toBeInTheDocument()
    expect(description().value).toBe('')
  })

  test('a skill holding a key gets the credentials note', async () => {
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route((body) => jsonResponse(200, {
      items: [{ key: body.items[0].key, error: 'skill_contains_credentials' }], modelUsed: null,
    })))
    await openEdit()
    fireEvent.click(generateButton())
    expect(await screen.findByText('This file holds a key or token, so it was not sent to the model. Type the name and description.')).toBeInTheDocument()
  })

  test('a stored name over 100 characters (from before the limit) still lets Generate write the description', async () => {
    const longName = 'Legacy skill name '.repeat(7).trim()
    const stub = stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === LIST_URL && method === 'GET') return jsonResponse(200, [{ ...SKILL, name: longName }])
      if (url === `${LIST_URL}/sk1` && method === 'GET') return jsonResponse(200, { ...SKILL, name: longName, content: '# Pickle\n\nThe stored text.' })
      if (url.startsWith(`${LIST_URL}/name-check`)) return jsonResponse(200, { available: true, normalized: 'x', suggestion: null })
      if (url === GENERATE_URL && method === 'POST') {
        const body = JSON.parse(init!.body as string)
        // The route's own rule: a name over 100 characters is 400 items_invalid.
        if (body.items.some((i: { name: string }) => i.name.length > 100)) return jsonResponse(400, { error: 'x', code: 'items_invalid' })
        return answer(body)
      }
      return jsonResponse(404, {})
    })
    await openEdit()
    expect(longName.length).toBeGreaterThan(100)
    fireEvent.click(generateButton())
    await waitFor(() => expect(description().value).toBe('Tests Python pickle deserialization.'))
    expect(stub.calls(GENERATE_URL, 'POST')).toHaveLength(1)
  })

  test("a late Generate answer for a closed skill never shows on the next skill's dialog", async () => {
    const other = { ...SKILL, id: 'sk2', name: 'Second Skill' }
    let releaseFirst!: () => void
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === LIST_URL && method === 'GET') return jsonResponse(200, [SKILL, other])
      if (url === `${LIST_URL}/sk1` && method === 'GET') return jsonResponse(200, { ...SKILL, content: '# One' })
      if (url === `${LIST_URL}/sk2` && method === 'GET') return jsonResponse(200, { ...other, content: '# Two' })
      if (url.startsWith(`${LIST_URL}/name-check`)) return jsonResponse(200, { available: true, normalized: 'x', suggestion: null })
      if (url === GENERATE_URL && method === 'POST') {
        const key = JSON.parse(init!.body as string).items[0].key
        if (key === 'sk1') {
          return new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(jsonResponse(200, { items: [{ key, error: 'skill_contains_credentials' }], modelUsed: null }))
          })
        }
      }
      return jsonResponse(404, {})
    })
    await openEdit()
    fireEvent.click(generateButton())
    await waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(await screen.findByTestId('user-skill-sk2')).getByTitle('Edit name and description'))
    await screen.findByRole('heading', { name: 'Edit Skill' })
    expect(generateButton()).toBeEnabled()
    releaseFirst()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/This file holds a key or token/)).toBeNull()
  })

  test('the button is disabled when both fields are filled', async () => {
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route(answer))
    await openEdit()
    expect(generateButton()).toBeEnabled()
    fireEvent.change(description(), { target: { value: 'Now filled' } })
    expect(generateButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Change the Skill names & descriptions model' })).toBeInTheDocument()
  })
})
