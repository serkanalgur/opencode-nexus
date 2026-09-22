import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export interface AgentWorktree {
  agentId: string
  branch: string
  path: string
  createdAt: Date
}

export class WorktreeManager {
  private worktrees: Map<string, AgentWorktree> = new Map()
  private baseDir: string
  private repoRoot: string

  constructor(repoRoot: string, baseDir?: string) {
    this.repoRoot = repoRoot
    this.baseDir = baseDir || join(repoRoot, '.worktrees', 'nexus-agents')
  }

  /**
   * Create an isolated worktree for an agent
   */
  create(agentId: string): AgentWorktree {
    const branch = `nexus-agent-${agentId}`
    const path = join(this.baseDir, agentId)

    try {
      // Create base directory if needed
      if (!existsSync(this.baseDir)) {
        execSync(`mkdir -p "${this.baseDir}"`, { cwd: this.repoRoot })
      }

      // Create worktree
      execSync(`git worktree add "${path}" -b "${branch}" 2>/dev/null || git worktree add "${path}" "${branch}" 2>/dev/null || echo "Worktree exists"`, {
        cwd: this.repoRoot,
        timeout: 10000
      })

      const wt: AgentWorktree = { agentId, branch, path, createdAt: new Date() }
      this.worktrees.set(agentId, wt)
      return wt
    } catch (error: any) {
      throw new Error(`Failed to create worktree for ${agentId}: ${error.message}`)
    }
  }

  /**
   * Remove an agent's worktree
   */
  remove(agentId: string): boolean {
    const wt = this.worktrees.get(agentId)
    if (!wt) return false

    try {
      execSync(`git worktree remove "${wt.path}" --force 2>/dev/null`, {
        cwd: this.repoRoot,
        timeout: 10000
      })
      execSync(`git branch -D "${wt.branch}" 2>/dev/null`, {
        cwd: this.repoRoot,
        timeout: 5000
      })
      this.worktrees.delete(agentId)
      return true
    } catch {
      this.worktrees.delete(agentId)
      return false
    }
  }

  /**
   * Get worktree for an agent
   */
  get(agentId: string): AgentWorktree | undefined {
    return this.worktrees.get(agentId)
  }

  /**
   * List all active worktrees
   */
  list(): AgentWorktree[] {
    return [...this.worktrees.values()]
  }

  /**
   * Clean up all worktrees
   */
  cleanupAll(): void {
    for (const [id] of this.worktrees) {
      this.remove(id)
    }
  }

  /**
   * Get the path for an agent's worktree
   */
  getPath(agentId: string): string | null {
    return this.worktrees.get(agentId)?.path ?? null
  }
}
