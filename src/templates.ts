import type { Task, AgentRole } from "./types"

export interface TaskTemplate {
  name: string
  description: string
  steps: TaskTemplateStep[]
}

export interface TaskTemplateStep {
  role: AgentRole
  name: string
  description: string
  files: { include: string[]; exclude: string[] }
  timeout?: number
}

export const TEMPLATES: Record<string, TaskTemplate> = {
  feature: {
    name: 'Feature Development',
    description: 'Full feature pipeline: architect → coder → reviewer → tester',
    steps: [
      { role: 'architect', name: 'Design', description: 'Design the feature architecture and API', files: { include: ['**/*.ts'], exclude: ['node_modules'] } },
      { role: 'coder', name: 'Implement', description: 'Implement the feature according to design', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'reviewer', name: 'Review', description: 'Code review for quality, security, and correctness', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'tester', name: 'Test', description: 'Write and run tests for the feature', files: { include: ['test/**/*.ts'], exclude: ['node_modules'] } },
    ]
  },
  bugfix: {
    name: 'Bug Fix',
    description: 'Bug investigation and fix: explorer → coder → reviewer',
    steps: [
      { role: 'explorer', name: 'Investigate', description: 'Investigate the bug root cause', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'coder', name: 'Fix', description: 'Implement the bug fix', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'reviewer', name: 'Review', description: 'Review the fix for correctness', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
    ]
  },
  refactor: {
    name: 'Refactoring',
    description: 'Code refactoring: architect → coder → reviewer → tester',
    steps: [
      { role: 'architect', name: 'Plan', description: 'Plan the refactoring approach', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'coder', name: 'Refactor', description: 'Execute the refactoring', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'reviewer', name: 'Review', description: 'Review refactored code', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'tester', name: 'Verify', description: 'Run existing tests to ensure no regressions', files: { include: ['test/**/*.ts'], exclude: ['node_modules'] } },
    ]
  },
  documentation: {
    name: 'Documentation',
    description: 'Documentation update: explorer → documenter → reviewer',
    steps: [
      { role: 'explorer', name: 'Analyze', description: 'Analyze codebase to understand what needs documentation', files: { include: ['src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'documenter', name: 'Write', description: 'Write documentation', files: { include: ['**/*.md', 'src/**/*.ts'], exclude: ['node_modules'] } },
      { role: 'reviewer', name: 'Review', description: 'Review documentation for accuracy', files: { include: ['**/*.md'], exclude: ['node_modules'] } },
    ]
  }
}

const DEFAULT_COMPLEXITY = {
  overall: 50,
  factors: {
    fileCount: 1,
    codeLines: 100,
    dependencyDepth: 1,
    domainKnowledge: 1,
    riskLevel: 'medium' as const,
  }
}

/**
 * Instantiate a template as a list of Tasks with sequential dependencies
 */
export function instantiateTemplate(templateName: string, baseDir: string): Task[] {
  const template = TEMPLATES[templateName]
  if (!template) throw new Error(`Unknown template: ${templateName}. Available: ${Object.keys(TEMPLATES).join(', ')}`)

  return template.steps.map((step, index) => ({
    id: `${templateName}-${index + 1}-${step.role}`,
    name: `${template.name}: ${step.name}`,
    description: step.description,
    requiredRole: step.role,
    complexity: { ...DEFAULT_COMPLEXITY },
    files: {
      include: step.files.include.map(f => f.startsWith('/') ? f : `${baseDir}/${f}`),
      exclude: step.files.exclude,
    },
    dependencies: index > 0 ? [`${templateName}-${index}-${template.steps[index - 1].role}`] : [],
    timeout: step.timeout,
    status: 'pending' as const,
    priority: 'normal' as const,
  }))
}

export function listTemplates(): string[] {
  return Object.keys(TEMPLATES)
}

export function getTemplate(name: string): TaskTemplate | undefined {
  return TEMPLATES[name]
}
