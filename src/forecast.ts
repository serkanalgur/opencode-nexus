import type { Task, AgentRole, ComplexityScore } from "./types"

export interface CostEstimate {
  taskId: string
  taskName: string
  role: string
  model: string
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCost: number
  confidence: number  // 0-1
  breakdown: {
    inputCost: number
    outputCost: number
    overhead: number  // system prompt tokens
  }
}

export interface ForecastResult {
  estimates: CostEstimate[]
  totalEstimatedCost: number
  budgetRemaining: number
  withinBudget: boolean
}

export class CostForecaster {
  private modelPricing: Map<string, { input: number; output: number }> = new Map()

  constructor() {
    // Default pricing (per token)
    this.modelPricing.set('claude-sonnet-4-6', { input: 0.000015, output: 0.000075 })
    this.modelPricing.set('claude-opus-4-7', { input: 0.000075, output: 0.000375 })
    this.modelPricing.set('claude-haiku-4-5', { input: 0.000001, output: 0.000005 })
    this.modelPricing.set('gpt-5-mini', { input: 0.00000015, output: 0.0000006 })
    this.modelPricing.set('gpt-5', { input: 0.0000025, output: 0.00001 })
    this.modelPricing.set('gemini-2.5-flash', { input: 0.000000075, output: 0.0000003 })
  }

  updatePricing(modelId: string, input: number, output: number): void {
    this.modelPricing.set(modelId, { input, output })
  }

  /**
   * Estimate tokens needed for a task based on complexity
   */
  estimateTokens(task: Task, complexity: ComplexityScore): { input: number; output: number } {
    // Base: system prompt ~500 tokens, task description ~200 tokens
    const baseInput = 700
    // Scale by complexity
    const complexityMultiplier = 1 + (complexity.overall / 100) * 3  // 1x to 4x
    // Scale by file count
    const fileMultiplier = 1 + (task.files.include.length * 0.2)
    // Output: roughly proportional to input but smaller
    const input = Math.round(baseInput * complexityMultiplier * fileMultiplier)
    const output = Math.round(input * 0.5)  // Output is typically 30-70% of input
    return { input, output }
  }

  /**
   * Forecast cost for a single task
   */
  forecastTask(task: Task, role: string, modelId: string, complexity: ComplexityScore): CostEstimate {
    const { input, output } = this.estimateTokens(task, complexity)
    const pricing = this.modelPricing.get(modelId) || { input: 0.00001, output: 0.00005 }
    const inputCost = input * pricing.input
    const outputCost = output * pricing.output
    const overhead = 0.0001  // Small fixed overhead for session setup

    return {
      taskId: task.id,
      taskName: task.name,
      role,
      model: modelId,
      estimatedInputTokens: input,
      estimatedOutputTokens: output,
      estimatedCost: inputCost + outputCost + overhead,
      confidence: 0.6 + Math.random() * 0.3,  // 60-90% confidence
      breakdown: { inputCost, outputCost, overhead }
    }
  }

  /**
   * Forecast cost for multiple tasks
   */
  forecastAll(tasks: Array<{ task: Task; role: string; model: string; complexity: ComplexityScore }>, budgetRemaining: number): ForecastResult {
    const estimates = tasks.map(t => this.forecastTask(t.task, t.role, t.model, t.complexity))
    const totalEstimatedCost = estimates.reduce((sum, e) => sum + e.estimatedCost, 0)

    return {
      estimates,
      totalEstimatedCost,
      budgetRemaining,
      withinBudget: totalEstimatedCost <= budgetRemaining
    }
  }
}
