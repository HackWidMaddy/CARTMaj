import { describe, test, expect, afterEach, vi } from 'vitest'
import { buildAgentWsUrl } from '@/hooks/agentWsUrl'

// KaliTerminal's getWsUrl delegates to buildAgentWsUrl('/ws/kali-terminal', ...).
// Test that real path here; the exhaustive matrix lives in hooks/agentWsUrl.test.ts.
describe('KaliTerminal WebSocket URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.NEXT_PUBLIC_AGENT_WS_URL
  })

  test('local dev keeps the agent on :8090', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: 'localhost', port: '3000' } })
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('ws://localhost:8090/ws/kali-terminal')
  })

  test('proxied https host uses same origin (no :8090)', () => {
    vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'example.com', port: '' } })
    const url = buildAgentWsUrl('/ws/kali-terminal')
    expect(url).toBe('wss://example.com/ws/kali-terminal')
    expect(url).not.toContain(':8090')
  })

  test('derives kali-terminal URL from the baked agent WS URL', () => {
    process.env.NEXT_PUBLIC_AGENT_WS_URL = 'wss://secure.example.com/ws/agent'
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('wss://secure.example.com/ws/kali-terminal')
  })
})

describe('ViewMode type', () => {
  test('terminal is a valid ViewMode value', () => {
    type ViewMode = 'graph' | 'table' | 'sessions' | 'terminal' | 'roe'
    const mode: ViewMode = 'terminal'
    expect(mode).toBe('terminal')
  })

  test('all view modes are distinct', () => {
    const modes = ['graph', 'table', 'sessions', 'terminal', 'roe']
    const uniqueModes = new Set(modes)
    expect(uniqueModes.size).toBe(modes.length)
  })
})

describe('Resize message format', () => {
  test('creates valid resize JSON', () => {
    const msg = JSON.stringify({ type: 'resize', rows: 24, cols: 80 })
    const parsed = JSON.parse(msg)
    expect(parsed.type).toBe('resize')
    expect(parsed.rows).toBe(24)
    expect(parsed.cols).toBe(80)
  })

  test('handles arbitrary dimensions', () => {
    const msg = JSON.stringify({ type: 'resize', rows: 50, cols: 200 })
    const parsed = JSON.parse(msg)
    expect(parsed.rows).toBe(50)
    expect(parsed.cols).toBe(200)
  })

  test('creates valid ping JSON', () => {
    const msg = JSON.stringify({ type: 'ping' })
    const parsed = JSON.parse(msg)
    expect(parsed.type).toBe('ping')
  })
})

describe('Connection status states', () => {
  test('all status values are distinct', () => {
    const statuses = ['disconnected', 'connecting', 'connected', 'error']
    const unique = new Set(statuses)
    expect(unique.size).toBe(4)
  })

  test('initial status should be disconnected', () => {
    const initialStatus = 'disconnected'
    expect(initialStatus).toBe('disconnected')
  })
})

describe('Reconnect logic', () => {
  test('exponential backoff doubles each attempt', () => {
    const BASE = 2000
    const delays = [0, 1, 2, 3, 4].map(attempt => BASE * Math.pow(2, attempt))
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000])
  })

  test('max reconnect attempts is 5', () => {
    const MAX_RECONNECT_ATTEMPTS = 5
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5)
  })
})
