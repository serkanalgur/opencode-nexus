/**
 * Presets Example
 *
 * Shows how to apply configuration presets and list available presets.
 */

import { NexusOrchestrator } from '@serkanalgur/opencode-nexus'

const orch = new NexusOrchestrator()

// Apply a preset that balances cost and capability
orch.configManager.applyPreset('balanced')

// List all available presets
const presets = orch.configManager.listPresets()
console.log('Available presets:', presets)
// → ['minimal', 'balanced', 'enterprise', 'cost-optimized']
