import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', '..', 'src')

/**
 * Every file that registers plugin tools: `src/index.ts`, which declares the
 * namespace, then each module in `src/tools/`. Tests that read tool schemas or
 * the tool registry out of the SOURCE go through this, so moving a tool between
 * these files cannot make such a test pass by reading the wrong file.
 */
export function toolSourceFiles(): string[] {
  const tools = readdirSync(join(SRC, 'tools')).filter((f) => f.endsWith('.ts')).sort()
  return [join(SRC, 'index.ts'), ...tools.map((f) => join(SRC, 'tools', f))]
}

/** All of them, concatenated in `toolSourceFiles()` order. */
export function readToolSources(): string {
  return toolSourceFiles().map((f) => readFileSync(f, 'utf-8')).join('\n')
}

/**
 * One tool's registration block, from its `name: "…"` to the next
 * `editor.add({` (or the end of the source). Bounded by the next registration
 * rather than by a neighbouring tool's name, so it does not depend on which
 * tool happens to follow in the same file.
 */
export function toolBlock(source: string, name: string): string {
  const start = source.indexOf(`name: "${name}"`)
  if (start === -1) throw new Error(`no tool named ${name} in the tool sources`)
  const next = source.indexOf('editor.add({', start)
  return next === -1 ? source.slice(start) : source.slice(start, next)
}
