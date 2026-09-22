/**
 * Custom Module Example
 *
 * Demonstrates creating and registering a custom module
 * that listens to orchestrator events.
 */

import { NexusOrchestrator } from '@serkanalgur/opencode-nexus'

const orch = new NexusOrchestrator()

// Register a custom module that logs agent lifecycle events
orch.moduleRegistry.register({
  name: 'my-logger',
  description: 'Logs all agent events',
  version: '1.0.0',
  setup: async (ctx) => {
    ctx.on('agent:spawned', (agent) => {
      console.log(`Agent spawned: ${agent.name}`)
    })

    ctx.on('agent:terminated', (agent) => {
      console.log(`Agent terminated: ${agent.name}`)
    })
  },
})
