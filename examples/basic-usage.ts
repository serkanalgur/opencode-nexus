/**
 * Basic Usage Example
 *
 * Demonstrates creating an orchestrator, spawning agents,
 * and executing a simple task.
 */

import { NexusOrchestrator } from '@serkanalgur/opencode-nexus'

// Create orchestrator with budget constraints
const orchestrator = new NexusOrchestrator({
  budget: { maxTotalCost: 10.00, maxCostPerTask: 1.00 },
})

// Spawn agents for different roles
const architect = await orchestrator.spawnAgent({ role: 'architect' })
const coder = await orchestrator.spawnAgent({ role: 'coder' })

// Define and execute a task
const result = await orchestrator.execute({
  tasks: [
    {
      id: 'auth-feature',
      name: 'Implement JWT Auth',
      description: 'Add JWT authentication middleware',
      requiredRole: 'coder',
      dependencies: [],
      files: { include: ['src/auth/**'] },
      status: 'pending',
      priority: 'high',
    },
  ],
})

console.log(`Task completed. Total cost: $${result.totalCost.toFixed(4)}`)
