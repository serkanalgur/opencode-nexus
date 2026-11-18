/** Status, costs and queue tools. Registered from `setup()` in `src/index.ts`. */
import type { NexusModelCost } from "../orchestrator"
import type { ToolEditor, ToolDeps } from "./deps"
import { renderModelCostReport } from "../cost-report"
import { NOTIFICATIONS_TEST_DESCRIPTION, runNotificationsTest } from "./dashboard-actions"

export function registerStatusTools(editor: ToolEditor, deps: ToolDeps): void {
  const { orchestrator } = deps

  editor.add({
    name: "status",
    description: "Get orchestrator status, metrics, and the config files currently in effect (paths consulted, which existed, resolved role -> model map)",
    input: {
      type: "object",
      properties: {
        detailed: { type: "boolean", description: "Include detailed metrics" }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { detailed } = input as { detailed?: boolean }
      const status = orchestrator.getStatus(detailed)
      return { content: status }
    }
  })

  editor.add({
    name: "agents",
    description: "List all active agents",
    input: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by status" }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { filter } = input as { filter?: string }
      return { content: orchestrator.listAgents(filter) }
    }
  })

  editor.add({
    name: "costs",
    description: "Get cost report and budget status",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      return { content: orchestrator.getCostReport() }
    }
  })

  editor.add({
    name: "notifications.test",
    description: NOTIFICATIONS_TEST_DESCRIPTION,
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      return { content: await runNotificationsTest(orchestrator) }
    }
  })

  editor.add({
    name: "queue",
    description: "Show current task queue with priorities",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async () => {
      const state = orchestrator.getState()
      const tasks = state.tasks || []
      return { content: JSON.stringify(tasks, null, 2) }
    }
  })

  editor.add({
    name: "model.costs",
    description: "Show real model pricing from OpenCode, or set custom costs. All prices are USD per 1K tokens.",
    input: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model to show cost for, as 'provider/id', 'provider/id#variant', or a bare 'id' (optional, shows all if omitted). A '#variant' is priced as the underlying model: variants carry no price of their own, so effort changes token volume, not rate." },
        setInput: { type: "number", description: "Set input cost in USD per 1K tokens for a model (e.g. 0.003 for $3 per million tokens)" },
        setOutput: { type: "number", description: "Set output cost in USD per 1K tokens for a model (e.g. 0.015 for $15 per million tokens)" }
      },
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { model, setInput, setOutput } = input as { model?: string; setInput?: number; setOutput?: number }

      // Every price `modelCosts` holds is USD per 1K tokens.
      const per1k = (v: number) => `$${v}/1K tokens`

      // A tiered price list, rendered one line per row. `tiers` is ordered
      // untiered-base-first by `loadModelCosts` / `setModelCosts`, and a
      // context tier is labelled with the prompt size it applies ABOVE.
      const renderTiers = (cost: NexusModelCost): string =>
        cost.tiers
          .map(t => (t.threshold === undefined
            ? `base: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`
            : `over ${t.threshold} prompt tokens: in=${per1k(t.rates.input)}, out=${per1k(t.rates.output)}, cache_read=${per1k(t.rates.cacheRead)}, cache_write=${per1k(t.rates.cacheWrite)}`))
          .join('\n            ')

      if (model && setInput !== undefined && setOutput !== undefined) {
        // Set custom cost
        orchestrator.setModelCosts({ [model]: { input: setInput, output: setOutput } })
        return { content: `Set ${model}: input=${per1k(setInput)}, output=${per1k(setOutput)}` }
      }

      if (model) {
        // Show specific model cost. `modelCosts` is keyed by
        // "providerID/id" but users type either that or a bare id, so
        // `getModelCost` resolves both.
        const cost = orchestrator.getModelCost(model)
        if (cost) {
          return { content: `${model} (real pricing, from OpenCode):\n            ${renderTiers(cost)}` }
        }
        // No real pricing. Source this from the forecaster so the number
        // carries the rate AND the table it came from: the old
        // `estimateModelCost` printed a bare `estimated $X/1K tokens` whose
        // X was not a price at all but the mean of a real rate and a
        // hand-tuned relative table entry. A number with no unit and no
        // provenance is the one output this tool must never produce.
        const { pricing, source } = orchestrator.forecaster.priceFor(model)
        const label = source === 'model-costs'
          ? 'real pricing'
          : source === 'fallback-table'
            ? 'ESTIMATE (fallback table, not provider pricing)'
            : 'ESTIMATE (unknown model — no table knows this rate)'
        return { content: `${model}: no real pricing data.\n            ${label}: in=${per1k(pricing.input)}, out=${per1k(pricing.output)}, cache_read=${per1k(pricing.cacheRead)}, cache_write=${per1k(pricing.cacheWrite)}` }
      }

      // Show all loaded costs, grouped by provider.
      //
      // Grouping and price text both come from `src/model-groups.ts`, the
      // same helpers the TUI picker uses, so the two surfaces cannot drift
      // apart. The display names come from the ORCHESTRATOR's catalogue
      // (`getProviderList`, loaded once at `initialize()`), not from a
      // `ctx.provider.list()` here: this tool used to run its own fetch on
      // every call, which meant the dashboard and this report were reading
      // two different snapshots of the same data and could print different
      // headings for the same models. One snapshot, one answer. The cost of
      // that is boot-time staleness, which is stated in `loadProviderNames`
      // and in the README.
      //
      // `renderTiers` is NOT used here: it prints four rates per tier and a
      // multi-line block per model, which is right for the single-model
      // report above and unreadable as a catalogue. The single-model branch
      // keeps it, and keeps its cache rates, so nothing this branch stops
      // showing is unreachable.
      return {
        content: renderModelCostReport(
          orchestrator.modelCosts,
          orchestrator.getProviderList(),
        )
      }
    }
  })
}
