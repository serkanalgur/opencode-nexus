/** ast-grep tools. Registered from `setup()` in `src/index.ts`. */
import { AstGrep } from "../astgrep"
import type { ToolEditor, ToolDeps } from "./deps"

export function registerAstgrepTools(editor: ToolEditor, deps: ToolDeps): void {
  const astGrep = new AstGrep()

  // AST-Grep tools
  editor.add({
    name: "astgrep.search",
    description: "Search for AST patterns in codebase",
    input: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "AST pattern to search for" },
        language: { type: "string", description: "Programming language (typescript, python, etc.)" },
        directory: { type: "string", description: "Directory to search in" }
      },
      required: ["pattern", "language", "directory"],
      additionalProperties: false
    },
    options: { codemode: true },
    execute: async (input: unknown) => {
      const { pattern, language, directory } = input as { pattern: string; language: string; directory: string }
      const results = astGrep.search(pattern, language, directory)
      if (results.length === 0) return { content: `No matches found for "${pattern}" in ${language}` }
      const lines = results.map(r => `${r.file}:${r.line} — ${r.match}`)
      return { content: `Found ${results.length} matches:\n${lines.join('\n')}` }
    }
  })

  editor.add({
    name: "astgrep.status",
    description: "Check if ast-grep is installed",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: true },
    execute: async () => {
      const available = astGrep.isAvailable()
      return { content: available ? "✅ ast-grep is installed" : "❌ ast-grep is not installed. Install with: cargo install ast-grep" }
    }
  })
}
