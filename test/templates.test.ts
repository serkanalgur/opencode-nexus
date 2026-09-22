import { describe, it, expect } from 'bun:test'
import { TEMPLATES, instantiateTemplate, listTemplates, getTemplate } from '../src/templates'

describe('TEMPLATES', () => {
  it('should define 4 templates', () => {
    const keys = Object.keys(TEMPLATES)
    expect(keys.length).toBe(4)
    expect(keys).toContain('feature')
    expect(keys).toContain('bugfix')
    expect(keys).toContain('refactor')
    expect(keys).toContain('documentation')
  })

  it('feature template should have 4 steps', () => {
    expect(TEMPLATES.feature.steps.length).toBe(4)
    expect(TEMPLATES.feature.steps[0].role).toBe('architect')
    expect(TEMPLATES.feature.steps[1].role).toBe('coder')
    expect(TEMPLATES.feature.steps[2].role).toBe('reviewer')
    expect(TEMPLATES.feature.steps[3].role).toBe('tester')
  })

  it('bugfix template should have 3 steps', () => {
    expect(TEMPLATES.bugfix.steps.length).toBe(3)
    expect(TEMPLATES.bugfix.steps[0].role).toBe('explorer')
    expect(TEMPLATES.bugfix.steps[1].role).toBe('coder')
    expect(TEMPLATES.bugfix.steps[2].role).toBe('reviewer')
  })

  it('refactor template should have 4 steps', () => {
    expect(TEMPLATES.refactor.steps.length).toBe(4)
    expect(TEMPLATES.refactor.steps[0].role).toBe('architect')
    expect(TEMPLATES.refactor.steps[1].role).toBe('coder')
    expect(TEMPLATES.refactor.steps[2].role).toBe('reviewer')
    expect(TEMPLATES.refactor.steps[3].role).toBe('tester')
  })

  it('documentation template should have 3 steps', () => {
    expect(TEMPLATES.documentation.steps.length).toBe(3)
    expect(TEMPLATES.documentation.steps[0].role).toBe('explorer')
    expect(TEMPLATES.documentation.steps[1].role).toBe('documenter')
    expect(TEMPLATES.documentation.steps[2].role).toBe('reviewer')
  })
})

describe('listTemplates', () => {
  it('should return all template names', () => {
    const names = listTemplates()
    expect(names).toEqual(['feature', 'bugfix', 'refactor', 'documentation'])
  })
})

describe('getTemplate', () => {
  it('should return a template by name', () => {
    const t = getTemplate('feature')
    expect(t).toBeDefined()
    expect(t!.name).toBe('Feature Development')
  })

  it('should return undefined for unknown template', () => {
    const t = getTemplate('nonexistent')
    expect(t).toBeUndefined()
  })
})

describe('instantiateTemplate', () => {
  it('should create tasks from feature template', () => {
    const tasks = instantiateTemplate('feature', '/project')
    expect(tasks.length).toBe(4)
  })

  it('should create tasks with proper IDs', () => {
    const tasks = instantiateTemplate('feature', '/project')
    expect(tasks[0].id).toBe('feature-1-architect')
    expect(tasks[1].id).toBe('feature-2-coder')
    expect(tasks[2].id).toBe('feature-3-reviewer')
    expect(tasks[3].id).toBe('feature-4-tester')
  })

  it('should set sequential dependencies', () => {
    const tasks = instantiateTemplate('feature', '/project')
    // First task has no dependencies
    expect(tasks[0].dependencies).toEqual([])
    // Subsequent tasks depend on the previous one
    expect(tasks[1].dependencies).toEqual(['feature-1-architect'])
    expect(tasks[2].dependencies).toEqual(['feature-2-coder'])
    expect(tasks[3].dependencies).toEqual(['feature-3-reviewer'])
  })

  it('should prefix file paths with baseDir', () => {
    const tasks = instantiateTemplate('feature', '/my/project')
    expect(tasks[0].files.include[0]).toBe('/my/project/**/*.ts')
    expect(tasks[1].files.include[0]).toBe('/my/project/src/**/*.ts')
  })

  it('should preserve file exclusions', () => {
    const tasks = instantiateTemplate('feature', '/project')
    for (const task of tasks) {
      expect(task.files.exclude).toContain('node_modules')
    }
  })

  it('should set all tasks to pending status', () => {
    const tasks = instantiateTemplate('feature', '/project')
    for (const task of tasks) {
      expect(task.status).toBe('pending')
    }
  })

  it('should set all tasks to normal priority', () => {
    const tasks = instantiateTemplate('feature', '/project')
    for (const task of tasks) {
      expect(task.priority).toBe('normal')
    }
  })

  it('should include complexity score', () => {
    const tasks = instantiateTemplate('feature', '/project')
    for (const task of tasks) {
      expect(task.complexity).toBeDefined()
      expect(task.complexity.overall).toBe(50)
      expect(task.complexity.factors.riskLevel).toBe('medium')
    }
  })

  it('should throw for unknown template', () => {
    expect(() => instantiateTemplate('nonexistent', '/project')).toThrow('Unknown template: nonexistent')
  })

  it('should include available template names in error message', () => {
    try {
      instantiateTemplate('bad', '/project')
    } catch (e: any) {
      expect(e.message).toContain('feature')
      expect(e.message).toContain('bugfix')
    }
  })

  it('should create tasks from bugfix template with correct roles', () => {
    const tasks = instantiateTemplate('bugfix', '/project')
    expect(tasks.length).toBe(3)
    expect(tasks[0].requiredRole).toBe('explorer')
    expect(tasks[1].requiredRole).toBe('coder')
    expect(tasks[2].requiredRole).toBe('reviewer')
  })

  it('bugfix first task should have no dependencies', () => {
    const tasks = instantiateTemplate('bugfix', '/project')
    expect(tasks[0].dependencies).toEqual([])
  })

  it('bugfix second task should depend on first', () => {
    const tasks = instantiateTemplate('bugfix', '/project')
    expect(tasks[1].dependencies).toEqual(['bugfix-1-explorer'])
  })

  it('should create tasks from documentation template', () => {
    const tasks = instantiateTemplate('documentation', '/project')
    expect(tasks.length).toBe(3)
    expect(tasks[0].requiredRole).toBe('explorer')
    expect(tasks[1].requiredRole).toBe('documenter')
    expect(tasks[2].requiredRole).toBe('reviewer')
  })

  it('should create tasks from refactor template with correct dependencies', () => {
    const tasks = instantiateTemplate('refactor', '/project')
    expect(tasks.length).toBe(4)
    expect(tasks[0].dependencies).toEqual([])
    expect(tasks[1].dependencies).toEqual(['refactor-1-architect'])
    expect(tasks[2].dependencies).toEqual(['refactor-2-coder'])
    expect(tasks[3].dependencies).toEqual(['refactor-3-reviewer'])
  })

  it('should set task names to include template and step names', () => {
    const tasks = instantiateTemplate('feature', '/project')
    expect(tasks[0].name).toBe('Feature Development: Design')
    expect(tasks[1].name).toBe('Feature Development: Implement')
    expect(tasks[2].name).toBe('Feature Development: Review')
    expect(tasks[3].name).toBe('Feature Development: Test')
  })
})
