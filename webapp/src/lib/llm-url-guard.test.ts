import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DNS resolution so tests are deterministic and offline.
const lookupMock = vi.fn()
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookupMock(...args) },
    lookup: (...args: unknown[]) => lookupMock(...args),
  }
})

import { assertSafeLlmBaseUrl, BaseUrlValidationError } from './llm-url-guard'

function resolvesTo(map: Record<string, string[]>) {
  lookupMock.mockImplementation(async (host: string) => {
    if (host in map) return map[host].map((address) => ({ address, family: 4 }))
    const err = new Error('ENOTFOUND') as NodeJS.ErrnoException
    err.code = 'ENOTFOUND'
    throw err
  })
}

describe('assertSafeLlmBaseUrl', () => {
  beforeEach(() => {
    lookupMock.mockReset()
    resolvesTo({})
  })

  describe('allows legitimate self-hosted targets', () => {
    it('no-ops on empty / null / whitespace', async () => {
      await expect(assertSafeLlmBaseUrl('')).resolves.toBeUndefined()
      await expect(assertSafeLlmBaseUrl(null)).resolves.toBeUndefined()
      await expect(assertSafeLlmBaseUrl('   ')).resolves.toBeUndefined()
    })

    it('allows localhost ollama', async () => {
      resolvesTo({ localhost: ['127.0.0.1'] })
      await expect(assertSafeLlmBaseUrl('http://localhost:11434/v1')).resolves.toBeUndefined()
    })

    it('allows loopback / private literals (no DNS needed)', async () => {
      await expect(assertSafeLlmBaseUrl('http://127.0.0.1:8080/v1')).resolves.toBeUndefined()
      await expect(assertSafeLlmBaseUrl('http://192.168.1.50:11434/v1')).resolves.toBeUndefined()
      await expect(assertSafeLlmBaseUrl('http://10.0.0.5:1234/v1')).resolves.toBeUndefined()
      await expect(assertSafeLlmBaseUrl('http://172.16.4.4:11434/v1')).resolves.toBeUndefined()
    })

    it('allows docker service name', async () => {
      resolvesTo({ ollama: ['172.20.0.3'] })
      await expect(assertSafeLlmBaseUrl('http://ollama:11434/v1')).resolves.toBeUndefined()
    })

    it('allows public https provider with TLS on', async () => {
      resolvesTo({ 'api.openai.com': ['1.2.3.4'] })
      await expect(assertSafeLlmBaseUrl('https://api.openai.com/v1')).resolves.toBeUndefined()
    })

    it('allows unresolvable host', async () => {
      await expect(
        assertSafeLlmBaseUrl('http://does-not-exist.invalid:11434/v1'),
      ).resolves.toBeUndefined()
    })

    it('allows TLS-off for private/loopback hosts', async () => {
      await expect(
        assertSafeLlmBaseUrl('https://192.168.1.50:8443/v1', { sslVerify: false }),
      ).resolves.toBeUndefined()
      await expect(
        assertSafeLlmBaseUrl('https://127.0.0.1:8443/v1', { sslVerify: false }),
      ).resolves.toBeUndefined()
    })
  })

  describe('blocks SSRF targets', () => {
    it.each([
      ['http://169.254.169.254/latest/meta-data/', 'AWS IMDS literal'],
      ['http://169.254.170.2/v2/credentials/', 'AWS ECS metadata'],
      ['http://100.100.100.200/latest/meta-data/', 'Alibaba metadata'],
      ['http://169.254.10.20:8000/v1', 'link-local range'],
    ])('blocks %s (%s)', async (url) => {
      await expect(assertSafeLlmBaseUrl(url)).rejects.toBeInstanceOf(BaseUrlValidationError)
    })

    it('blocks GCP metadata hostname', async () => {
      await expect(
        assertSafeLlmBaseUrl('http://metadata.google.internal/computeMetadata/v1/'),
      ).rejects.toBeInstanceOf(BaseUrlValidationError)
    })

    it('blocks DNS rebind to metadata IP', async () => {
      resolvesTo({ 'evil.example.com': ['169.254.169.254'] })
      await expect(
        assertSafeLlmBaseUrl('http://evil.example.com/v1'),
      ).rejects.toBeInstanceOf(BaseUrlValidationError)
    })

    it('blocks IPv4-mapped IPv6 metadata address', async () => {
      resolvesTo({ 'evil6.example.com': ['::ffff:169.254.169.254'] })
      await expect(
        assertSafeLlmBaseUrl('http://evil6.example.com/v1'),
      ).rejects.toBeInstanceOf(BaseUrlValidationError)
    })

    it.each(['file:///etc/passwd', 'gopher://127.0.0.1:6379/', 'ftp://host/x'])(
      'blocks non-http scheme %s',
      async (url) => {
        await expect(assertSafeLlmBaseUrl(url)).rejects.toBeInstanceOf(BaseUrlValidationError)
      },
    )
  })

  describe('blocks TLS-off on public host (I16)', () => {
    it('blocks public literal with sslVerify=false', async () => {
      await expect(
        assertSafeLlmBaseUrl('https://8.8.8.8/v1', { sslVerify: false }),
      ).rejects.toBeInstanceOf(BaseUrlValidationError)
    })

    it('blocks public hostname with sslVerify=false', async () => {
      resolvesTo({ 'evil-llm.example.com': ['8.8.4.4'] })
      await expect(
        assertSafeLlmBaseUrl('https://evil-llm.example.com/v1', { sslVerify: false }),
      ).rejects.toBeInstanceOf(BaseUrlValidationError)
    })

    it('allows public hostname with sslVerify=true', async () => {
      resolvesTo({ 'evil-llm.example.com': ['8.8.4.4'] })
      await expect(
        assertSafeLlmBaseUrl('https://evil-llm.example.com/v1', { sslVerify: true }),
      ).resolves.toBeUndefined()
    })
  })
})
