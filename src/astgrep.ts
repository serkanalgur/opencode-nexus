// AST-grep integration for pattern-aware code search and rewriting

import { execSync } from "node:child_process"

export interface AstGrepPattern {
  pattern: string
  language: string
  rewrite?: string
}

export interface AstGrepResult {
  file: string
  line: number
  column: number
  match: string
  replacement?: string
}

export class AstGrep {
  private _available: boolean | null = null

  /**
   * Search for pattern in codebase using ast-grep
   */
  search(pattern: string, language: string, directory: string): AstGrepResult[] {
    if (!this.isAvailable()) {
      return []
    }

    try {
      const cmd = `sg run --pattern "${pattern}" --lang ${language} --json ${directory}`
      const output = execSync(cmd, { encoding: "utf-8", timeout: 30000 })
      const results = JSON.parse(output)

      if (!Array.isArray(results)) return []

      return results.map((r: any) => ({
        file: r.file?.path || r.file || "",
        line: r.range?.start?.line || 0,
        column: r.range?.start?.column || 0,
        match: r.text || r.source || "",
      }))
    } catch {
      return []
    }
  }

  /**
   * Rewrite pattern in codebase using ast-grep
   */
  rewrite(
    pattern: string,
    rewrite: string,
    language: string,
    directory: string
  ): { count: number; results: AstGrepResult[] } {
    if (!this.isAvailable()) {
      return { count: 0, results: [] }
    }

    try {
      const cmd = `sg run --pattern "${pattern}" --rewrite "${rewrite}" --lang ${language} --json ${directory}`
      const output = execSync(cmd, { encoding: "utf-8", timeout: 30000 })
      const results = JSON.parse(output)

      if (!Array.isArray(results)) {
        return { count: 0, results: [] }
      }

      const mapped = results.map((r: any) => ({
        file: r.file?.path || r.file || "",
        line: r.range?.start?.line || 0,
        column: r.range?.start?.column || 0,
        match: r.text || r.source || "",
        replacement: r.replacement || undefined,
      }))

      return { count: mapped.length, results: mapped }
    } catch {
      return { count: 0, results: [] }
    }
  }

  /**
   * Check if ast-grep (sg) is installed
   */
  isAvailable(): boolean {
    if (this._available !== null) return this._available

    try {
      execSync("sg --version", { encoding: "utf-8", timeout: 5000 })
      this._available = true
    } catch {
      this._available = false
    }

    return this._available
  }

  /**
   * Get a formatted status string
   */
  status(): string {
    const available = this.isAvailable()
    if (available) {
      try {
        const version = execSync("sg --version", { encoding: "utf-8", timeout: 5000 }).trim()
        return `✅ ast-grep is installed (${version})`
      } catch {
        return "✅ ast-grep is installed"
      }
    }
    return "❌ ast-grep is not installed. Install with: brew install ast-grep"
  }
}
