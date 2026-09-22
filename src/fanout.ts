import type { AgentMessage } from "./types"

export interface FanOutRouter {
  routes: Map<string, Set<string>> // topic → Set<subscriberId>
  wildcardRoutes: Set<string>     // subscribers that want all messages
}

export class MessageRouter {
  private routes: Map<string, Set<string>> = new Map()
  private wildcardSubscribers: Set<string> = new Set()
  private messageHandlers: Map<string, (msg: AgentMessage) => void> = new Map()

  /**
   * Subscribe to a specific topic or pattern
   * Use '*' for wildcard (all messages)
   */
  subscribe(subscriberId: string, topic: string, handler: (msg: AgentMessage) => void): void {
    this.messageHandlers.set(subscriberId, handler)
    
    if (topic === '*') {
      this.wildcardSubscribers.add(subscriberId)
    } else {
      const subs = this.routes.get(topic) || new Set()
      subs.add(subscriberId)
      this.routes.set(topic, subs)
    }
  }

  unsubscribe(subscriberId: string): void {
    this.messageHandlers.delete(subscriberId)
    this.wildcardSubscribers.delete(subscriberId)
    for (const subs of this.routes.values()) {
      subs.delete(subscriberId)
    }
  }

  /**
   * Route a message to matching subscribers
   */
  route(message: AgentMessage): string[] {
    const deliveredTo: string[] = []
    
    // Exact topic match
    const exactSubs = this.routes.get(message.topic!)
    if (exactSubs) {
      for (const subId of exactSubs) {
        const handler = this.messageHandlers.get(subId)
        if (handler) {
          handler(message)
          deliveredTo.push(subId)
        }
      }
    }

    // Wildcard match
    for (const subId of this.wildcardSubscribers) {
      if (!deliveredTo.includes(subId)) {
        const handler = this.messageHandlers.get(subId)
        if (handler) {
          handler(message)
          deliveredTo.push(subId)
        }
      }
    }

    return deliveredTo
  }

  /**
   * Broadcast to all subscribers (ignoring topic)
   */
  broadcast(message: AgentMessage): void {
    for (const handler of this.messageHandlers.values()) {
      handler(message)
    }
  }

  getSubscribers(topic: string): string[] {
    const subs = this.routes.get(topic)
    return subs ? [...subs] : []
  }

  getWildcardSubscribers(): string[] {
    return [...this.wildcardSubscribers]
  }

  getStats(): { topics: number; totalSubscribers: number; wildcardSubscribers: number } {
    return {
      topics: this.routes.size,
      totalSubscribers: this.messageHandlers.size,
      wildcardSubscribers: this.wildcardSubscribers.size
    }
  }
}
