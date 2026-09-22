import type { AgentMessage } from "./types"
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

export interface MessageStoreConfig {
  storagePath: string
  maxMessages: number
  rotationSize: number  // rotate file after this many messages
}

const DEFAULT_CONFIG: MessageStoreConfig = {
  storagePath: join(process.env.HOME || '~', '.local', 'share', 'opencode-nexus', 'messages.jsonl'),
  maxMessages: 10000,
  rotationSize: 1000,
}

export class MessageStore {
  private messages: AgentMessage[] = []
  private config: MessageStoreConfig
  private writeCount: number = 0

  constructor(config?: Partial<MessageStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(this.config.storagePath)) {
        const raw = readFileSync(this.config.storagePath, 'utf-8')
        const lines = raw.split('\n').filter(l => l.trim())
        this.messages = lines.map(l => JSON.parse(l)).slice(-this.config.maxMessages)
      }
    } catch {
      // Start fresh on any error
      this.messages = []
    }
  }

  private ensureDir(): void {
    try {
      mkdirSync(dirname(this.config.storagePath), { recursive: true })
    } catch {}
  }

  add(message: AgentMessage): void {
    this.messages.push(message)

    // Trim to max
    if (this.messages.length > this.config.maxMessages) {
      this.messages = this.messages.slice(-this.config.maxMessages)
    }

    // Append to disk
    try {
      this.ensureDir()
      appendFileSync(this.config.storagePath, JSON.stringify(message) + '\n')
      this.writeCount++

      // Rotate if rotation size exceeded
      if (this.writeCount % this.config.rotationSize === 0) {
        this.rotate()
      }
    } catch {}
  }

  private rotate(): void {
    try {
      // Rewrite file with current in-memory messages (already trimmed to maxMessages)
      const content = this.messages.map(m => JSON.stringify(m)).join('\n') + '\n'
      const { writeFileSync } = require('node:fs') as typeof import('node:fs')
      writeFileSync(this.config.storagePath, content)
    } catch {}
  }

  getAll(): AgentMessage[] {
    return [...this.messages]
  }

  getByTopic(topic: string): AgentMessage[] {
    return this.messages.filter(m => m.topic === topic)
  }

  getByAgent(agentId: string): AgentMessage[] {
    return this.messages.filter(m => m.from === agentId || m.to === agentId)
  }

  getRecent(count: number): AgentMessage[] {
    return this.messages.slice(-count)
  }

  clear(): void {
    this.messages = []
    this.writeCount = 0
  }

  getStats(): { total: number; writeCount: number; fileSize: number } {
    let fileSize = 0
    try {
      if (existsSync(this.config.storagePath)) {
        const { statSync } = require('node:fs') as typeof import('node:fs')
        fileSize = statSync(this.config.storagePath).size
      }
    } catch {}
    return {
      total: this.messages.length,
      writeCount: this.writeCount,
      fileSize
    }
  }
}
