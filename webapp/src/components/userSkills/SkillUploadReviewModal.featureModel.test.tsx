/**
 * Generate with AI in the upload dialog runs on the user's "Skill names & descriptions"
 * model: the gate opens when none is saved, requests go 5 rows at a time with progress, only
 * empty fields are filled (a value typed meanwhile is kept), a non-gate code is a message,
 * a gate code reopens the gate and retries once, and a row's own failure is a note on it.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { AlertProvider, ToastProvider } from '@/components/ui'
import { GATE_USER, jsonResponse, pickInGate, stubGateFetch } from '@/components/shared/featureModelGate.testUtils'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: GATE_USER }) }))

import { FeatureModelGateProvider } from '@/components/shared/FeatureModelGate'
import { SkillUploadReviewModal } from './SkillUploadReviewModal'
import { featureModelMessage } from '@/lib/llmFeatures'
import type { PickedFile } from '@/lib/skillUploadDraft'

const GENERATE_URL = `/api/users/${GATE_USER}/attack-skills/generate-metadata`
const NAME_CHECK_URL = `/api/users/${GATE_USER}/attack-skills/name-check`

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type Item = { key: string; fields: string[]; fileName: string }

/** Routes the dialog's own calls; `generate` answers each generate-metadata POST. */
function route(generate: (items: Item[], n: number) => Response | Promise<Response>) {
  let n = 0
  return (url: string, init?: RequestInit) => {
    if (url === NAME_CHECK_URL) {
      const names = JSON.parse(init!.body as string).names as string[]
      return jsonResponse(200, { results: names.map((name) => ({ normalized: name, available: true, suggestion: null })) })
    }
    if (url === GENERATE_URL) return generate(JSON.parse(init!.body as string).items, ++n)
    return jsonResponse(404, {})
  }
}

const filled = (items: Item[]) => jsonResponse(200, {
  items: items.map((i) => ({
    key: i.key,
    ...(i.fields.includes('name') ? { name: `AI ${i.fileName}` } : {}),
    ...(i.fields.includes('description') ? { description: `About ${i.fileName}` } : {}),
  })),
  modelUsed: 'claude-haiku-4-5',
})

function draw(files: PickedFile[], mode: 'single' | 'batch' = 'batch') {
  render(
    <ToastProvider>
      <AlertProvider>
        <FeatureModelGateProvider>
          <SkillUploadReviewModal mode={mode} userId={GATE_USER} existingCount={0} files={files} cut={false} onClose={vi.fn()} />
        </FeatureModelGateProvider>
      </AlertProvider>
    </ToastProvider>,
  )
}

const plain = (i: number): PickedFile => ({ name: `s${i}.md`, text: `## Steps ${i}\n\nBody ${i}.` })
const generateButton = () => screen.getByRole('button', { name: /Generate (missing )?with AI/ })
const nameOf = (file: string) => screen.getByLabelText(`Name for ${file}`) as HTMLInputElement
const descriptionOf = (file: string) => screen.getByLabelText(`Description for ${file}`) as HTMLTextAreaElement

describe('Generate with AI in the upload dialog', () => {
  test('no saved model: the gate opens, then exactly one request; the choice is saved', async () => {
    const stub = stubGateFetch({}, route(filled))
    draw([plain(1)])
    fireEvent.click(generateButton())
    await pickInGate('Claude Haiku 4.5')
    await waitFor(() => expect(nameOf('s1.md').value).toBe('AI s1.md'))
    expect(stub.calls(GENERATE_URL, 'POST')).toHaveLength(1)
    expect(stub.saved).toEqual({ skill_metadata: 'claude-haiku-4-5' })
  })

  test('a saved model shows its id and the Change button', async () => {
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route(filled))
    draw([plain(1)])
    expect(await screen.findByText('claude-haiku-4-5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change the Skill names & descriptions model' })).toHaveTextContent('Change')
  })

  test('7 targets make 2 requests (5 + 2) with progress; only empty fields are filled, tagged AI', async () => {
    const releases: (() => void)[] = []
    const stub = stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route((items) => new Promise((resolve) => {
      releases.push(() => resolve(filled(items)))
    })))
    const files = [...Array.from({ length: 6 }, (_, i) => plain(i)), { name: 'named.md', text: '# Kept Name\n\nBody.' }]
    draw(files)
    fireEvent.click(generateButton())
    expect(await screen.findByText(/Writing 5 of 7/)).toBeInTheDocument()
    await act(async () => { releases[0]() })
    expect(await screen.findByText(/Writing 7 of 7/)).toBeInTheDocument()
    await act(async () => { releases[1]() })
    await waitFor(() => expect(screen.queryByText(/Writing \d+ of/)).toBeNull())

    const sent = stub.calls(GENERATE_URL, 'POST').map(([, init]) => JSON.parse(init!.body as string).items as Item[])
    expect(sent.map((items) => items.length)).toEqual([5, 2])
    const named = sent.flat().find((i) => i.fileName === 'named.md')!
    expect(named.fields).toEqual(['description'])
    expect(nameOf('named.md').value).toBe('Kept Name')
    expect(descriptionOf('named.md').value).toBe('About named.md')
    expect(nameOf('s0.md').value).toBe('AI s0.md')
    expect(within(screen.getByTestId('skill-upload-row-s0.md')).getAllByText('AI')).toHaveLength(2)
  })

  test('a name typed while the request runs is not overwritten', async () => {
    let release!: () => void
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route((items) => new Promise((resolve) => {
      release = () => resolve(filled(items))
    })))
    draw([plain(1)])
    fireEvent.click(generateButton())
    await screen.findByText(/Writing 1 of 1/)
    fireEvent.change(nameOf('s1.md'), { target: { value: 'Typed by me' } })
    await act(async () => { release() })
    await waitFor(() => expect(descriptionOf('s1.md').value).toBe('About s1.md'))
    expect(nameOf('s1.md').value).toBe('Typed by me')
  })

  test('a 504 agent_timeout is its message, and the gate never opens', async () => {
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route(() => jsonResponse(504, {
      error: 'x', code: 'agent_timeout', featureId: 'skill_metadata',
    })))
    draw([plain(1)])
    fireEvent.click(generateButton())
    expect(await screen.findByText(featureModelMessage('agent_timeout'))).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(nameOf('s1.md').value).toBe('')
  })

  test('model_required from the route reopens the gate and retries exactly once', async () => {
    const stub = stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route((items, n) => (n === 1
      ? jsonResponse(409, { error: 'x', code: 'model_required', featureId: 'skill_metadata' })
      : filled(items))))
    draw([plain(1)])
    fireEvent.click(generateButton())
    await pickInGate('Claude Opus 4.6')
    await waitFor(() => expect(nameOf('s1.md').value).toBe('AI s1.md'))
    expect(stub.calls(GENERATE_URL, 'POST')).toHaveLength(2)
  })

  test("a row's own error is a note; a file holding a key gets the credentials note and stays editable", async () => {
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route((items) => jsonResponse(200, {
      items: [{ key: items[0].key, error: 'timeout' }, { key: items[1].key, error: 'skill_contains_credentials' }],
      modelUsed: 'claude-haiku-4-5',
    })))
    draw([plain(1), { name: 'f12_secret.md', text: '# Secret\n\naws_access_key_id = AKIAIOSFODNN7EXAMPLE' }])
    fireEvent.click(generateButton())
    expect(await screen.findByText('The AI could not write this one. Type it, or try again.')).toBeInTheDocument()
    expect(screen.getByText('This file holds a key or token, so it was not sent to the model. Type the name and description.')).toBeInTheDocument()
    expect(nameOf('f12_secret.md')).toBeEnabled()
    expect(descriptionOf('f12_secret.md').value).toBe('')
  })

  test('a double click on Generate starts one run, not two billed in parallel', async () => {
    const stub = stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route(filled))
    draw([plain(1)])
    fireEvent.click(generateButton())
    fireEvent.click(generateButton())
    await waitFor(() => expect(nameOf('s1.md').value).toBe('AI s1.md'))
    await waitFor(() => expect(screen.queryByText(/Writing \d+ of/)).toBeNull())
    expect(stub.calls(GENERATE_URL, 'POST')).toHaveLength(1)
  })

  test('a row unchecked while Generate runs is not sent in a later request', async () => {
    const releases: (() => void)[] = []
    const stub = stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route((items) => new Promise((resolve) => {
      releases.push(() => resolve(filled(items)))
    })))
    draw(Array.from({ length: 7 }, (_, i) => plain(i)))
    fireEvent.click(generateButton())
    expect(await screen.findByText(/Writing 5 of 7/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Include s6.md'))
    await act(async () => { releases[0]() })
    await waitFor(() => expect(releases).toHaveLength(2))
    await act(async () => { releases[1]() })
    const sent = stub.calls(GENERATE_URL, 'POST').map(([, init]) => (JSON.parse(init!.body as string).items as Item[]).map((i) => i.fileName))
    expect(sent).toEqual([['s0.md', 's1.md', 's2.md', 's3.md', 's4.md'], ['s5.md']])
  })

  test('single mode reads "Generate with AI"; disabled with its title when every field is filled', async () => {
    stubGateFetch({ skill_metadata: 'claude-haiku-4-5' }, route(filled))
    draw([{ name: 'full.md', text: '---\nname: Full\ndescription: Done.\n---\n# Full' }], 'single')
    const button = screen.getByRole('button', { name: 'Generate with AI' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Every name and description is filled')
  })
})
