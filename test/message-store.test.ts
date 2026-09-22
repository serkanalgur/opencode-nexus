import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MessageStore, type MessageStoreConfig } from '../src/message-store'
import { unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage } from '../src/types'

// Use a temp directory for tests
const TEST_DIR = join(import.meta.dir, '..', '.test-tmp')
const TEST_PATH = join(TEST_DIR, 'test-messages.jsonl')

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: 'agent-1',
    to: 'agent-2',
    topic: 'test-topic',
    type: 'status-update',
    payload: { status: 'working' },
    timestamp: new Date(),
    metadata: { priority: 'normal', requiresResponse: false },
    ...overrides,
  }
}

function makeConfig(overrides?: Partial<MessageStoreConfig>): Partial<MessageStoreConfig> {
  return {
    storagePath: TEST_PATH,
    maxMessages: 50,
    rotationSize: 10,
    ...overrides,
  }
}

function cleanup() {
  try {
    if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH)
    const orchPath = join(TEST_DIR, 'orch-pub-test.jsonl')
    if (existsSync(orchPath)) unlinkSync(orchPath)
  } catch {}
}

describe('MessageStore', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    cleanup()
  })

  afterEach(() => {
    cleanup()
  })

  describe('constructor', () => {
    it('should create a new store with empty messages', () => {
      const store = new MessageStore(makeConfig())
      expect(store.getAll()).toEqual([])
    })

    it('should load messages from disk on construction', () => {
      // Write a test file manually
      const fs = require('node:fs')
      const msg1 = makeMessage({ id: 'msg-disk-1' })
      const msg2 = makeMessage({ id: 'msg-disk-2' })
      fs.writeFileSync(TEST_PATH, JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n')

      const store = new MessageStore(makeConfig())
      const messages = store.getAll()
      expect(messages).toHaveLength(2)
      expect(messages[0].id).toBe('msg-disk-1')
      expect(messages[1].id).toBe('msg-disk-2')
    })

    it('should handle corrupt file gracefully', () => {
      const fs = require('node:fs')
      fs.writeFileSync(TEST_PATH, 'not json\n{broken\n')

      const store = new MessageStore(makeConfig())
      expect(store.getAll()).toEqual([])
    })
  })

  describe('add', () => {
    it('should store a message in memory', () => {
      const store = new MessageStore(makeConfig())
      const msg = makeMessage()
      store.add(msg)

      const messages = store.getAll()
      expect(messages).toHaveLength(1)
      expect(messages[0].id).toBe(msg.id)
    })

    it('should persist to disk', () => {
      const store = new MessageStore(makeConfig())
      const msg = makeMessage()
      store.add(msg)

      const fs = require('node:fs')
      const raw = fs.readFileSync(TEST_PATH, 'utf-8')
      const parsed = JSON.parse(raw.trim())
      expect(parsed.id).toBe(msg.id)
    })

    it('should persist multiple messages as JSONL', () => {
      const store = new MessageStore(makeConfig())
      store.add(makeMessage({ id: 'm1' }))
      store.add(makeMessage({ id: 'm2' }))
      store.add(makeMessage({ id: 'm3' }))

      const fs = require('node:fs')
      const raw = fs.readFileSync(TEST_PATH, 'utf-8')
      const lines = raw.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(3)
    })

    it('should trim to maxMessages', () => {
      const store = new MessageStore(makeConfig({ maxMessages: 3 }))

      for (let i = 0; i < 5; i++) {
        store.add(makeMessage({ id: `msg-${i}` }))
      }

      const messages = store.getAll()
      expect(messages).toHaveLength(3)
      expect(messages[0].id).toBe('msg-2')
      expect(messages[2].id).toBe('msg-4')
    })

    it('should update write count', () => {
      const store = new MessageStore(makeConfig())
      store.add(makeMessage())
      store.add(makeMessage())

      const stats = store.getStats()
      expect(stats.writeCount).toBe(2)
    })

    it('should auto-create directory if missing', () => {
      const deepPath = join(TEST_DIR, 'nested', 'dir', 'msgs.jsonl')
      const store = new MessageStore(makeConfig({ storagePath: deepPath }))
      store.add(makeMessage())

      expect(existsSync(deepPath)).toBe(true)

      // cleanup
      try {
        unlinkSync(deepPath)
        const { rmdirSync } = require('node:fs')
        rmdirSync(join(TEST_DIR, 'nested', 'dir'))
        rmdirSync(join(TEST_DIR, 'nested'))
      } catch {}
    })
  })

  describe('query methods', () => {
    let store: MessageStore

    beforeEach(() => {
      store = new MessageStore(makeConfig())
      store.add(makeMessage({ id: 'm1', topic: 'task-updates', from: 'agent-a', to: 'agent-b' }))
      store.add(makeMessage({ id: 'm2', topic: 'reviews', from: 'agent-c', to: 'agent-a' }))
      store.add(makeMessage({ id: 'm3', topic: 'task-updates', from: 'agent-b', to: 'agent-a' }))
      store.add(makeMessage({ id: 'm4', topic: 'reviews', from: 'agent-a', to: 'agent-c' }))
    })

    it('getByTopic filters correctly', () => {
      const taskMsgs = store.getByTopic('task-updates')
      expect(taskMsgs).toHaveLength(2)
      expect(taskMsgs.every(m => m.topic === 'task-updates')).toBe(true)
    })

    it('getByAgent filters messages where agent is sender or receiver', () => {
      const agentAMsgs = store.getByAgent('agent-a')
      expect(agentAMsgs).toHaveLength(4) // m1(from), m2(to), m3(to), m4(from)
    })

    it('getRecent returns last N messages', () => {
      const recent = store.getRecent(2)
      expect(recent).toHaveLength(2)
      expect(recent[0].id).toBe('m3')
      expect(recent[1].id).toBe('m4')
    })

    it('getRecent returns all if count exceeds total', () => {
      const recent = store.getRecent(100)
      expect(recent).toHaveLength(4)
    })
  })

  describe('clear', () => {
    it('should clear all messages and reset write count', () => {
      const store = new MessageStore(makeConfig())
      store.add(makeMessage())
      store.add(makeMessage())
      expect(store.getStats().total).toBe(2)

      store.clear()
      expect(store.getStats().total).toBe(0)
      expect(store.getStats().writeCount).toBe(0)
    })
  })

  describe('stats', () => {
    it('should report correct stats', () => {
      const store = new MessageStore(makeConfig())
      store.add(makeMessage())
      store.add(makeMessage())

      const stats = store.getStats()
      expect(stats.total).toBe(2)
      expect(stats.writeCount).toBe(2)
      expect(stats.fileSize).toBeGreaterThan(0)
    })
  })

  describe('persistence across instances', () => {
    it('should survive process restart (new instance loads from disk)', () => {
      const config = makeConfig()

      // First instance: write messages
      const store1 = new MessageStore(config)
      store1.add(makeMessage({ id: 'persist-1' }))
      store1.add(makeMessage({ id: 'persist-2' }))

      // Second instance: should load from disk
      const store2 = new MessageStore(config)
      const messages = store2.getAll()
      expect(messages).toHaveLength(2)
      expect(messages[0].id).toBe('persist-1')
      expect(messages[1].id).toBe('persist-2')
    })
  })
})

describe('NexusOrchestrator integration', () => {
  // Minimal integration test to verify publish persists
  it('should store messages via messageStore on publish', () => {
    const { NexusOrchestrator } = require('../src/orchestrator')
    const testPath = join(TEST_DIR, 'orch-pub-test.jsonl')
    cleanup()

    const orch = new NexusOrchestrator({}, { storagePath: testPath, maxMessages: 100, rotationSize: 100 })
    orch.publish('test-topic', {
      from: 'agent-1',
      topic: 'test-topic',
      type: 'status-update',
      payload: { status: 'done' },
      metadata: { priority: 'normal', requiresResponse: false }
    })

    const stored = orch.messageStore.getAll()
    expect(stored).toHaveLength(1)
    expect(stored[0].topic).toBe('test-topic')

    try { unlinkSync(testPath) } catch {}
  })
})
