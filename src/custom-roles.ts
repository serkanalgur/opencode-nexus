export interface CustomRole {
  name: string
  displayName: string
  emoji: string
  prompt: string
  model?: string  // default model for this role
}

/**
 * What one `loadFromConfig` call did.
 *
 * Returned rather than only logged so the count of dropped entries is
 * something other code can read: a role the user wrote and did not get is a
 * defect, and `console.warn` alone cannot be asserted on by a test.
 */
export interface CustomRoleLoadReport {
  /** Names registered by this call, in config order. */
  registered: string[]
  /**
   * One entry per config entry that was NOT registered, and why. `name` is
   * null only when the entry carried no usable name to report it by. `index`
   * is -1 for the one failure that is about the block rather than an entry
   * inside it (`customRoles` not being an array), where there is no index to
   * point at.
   */
  skipped: Array<{ index: number; name: string | null; reason: string }>
}

/** Either a validated role or the reason the entry could not become one. */
type NormalizedRole =
  | { ok: true; role: CustomRole }
  | { ok: false; name: string | null; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty trimmed string, or null. `0`/false are not strings at all. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * Validate one `customRoles` entry.
 *
 * The two required fields are `name` and `prompt` and the bar for both is
 * "would this role be usable if it registered". A `name` is the lookup key, so
 * an absent one cannot even be reported by name. A `prompt` is the whole point:
 * `buildRolePrompt` falls back to a generic "You are a <role>" sentence when the
 * prompt is empty, so registering a promptless entry would produce a role that
 * looks configured and behaves as if it were not — the exact defect this file's
 * `loadFromConfig` wiring exists to remove, re-introduced one level down.
 *
 * `displayName` and `emoji` are presentation, so they default: to the name, and
 * to the same default the `roles.add` tool uses. `model` stays optional and is
 * resolved by `NexusConfigManager.getModelForRole`.
 */
function normalizeCustomRole(entry: unknown): NormalizedRole {
  if (!isRecord(entry)) {
    return { ok: false, name: null, reason: 'entry is not an object' }
  }
  const name = nonEmptyString(entry.name)
  if (name === null) {
    return { ok: false, name: null, reason: 'missing or empty "name"' }
  }
  const prompt = nonEmptyString(entry.prompt)
  if (prompt === null) {
    return { ok: false, name, reason: 'missing or empty "prompt"' }
  }
  const model = nonEmptyString(entry.model)
  return {
    ok: true,
    role: {
      name,
      prompt,
      displayName: nonEmptyString(entry.displayName) ?? name,
      emoji: nonEmptyString(entry.emoji) ?? '🤖',
      ...(model === null ? {} : { model })
    }
  }
}

export class CustomRoleManager {
  private roles: Map<string, CustomRole> = new Map()

  register(role: CustomRole): void {
    this.roles.set(role.name, role)
  }

  unregister(name: string): boolean {
    return this.roles.delete(name)
  }

  get(name: string): CustomRole | undefined {
    return this.roles.get(name)
  }

  list(): CustomRole[] {
    return [...this.roles.values()]
  }

  getPrompt(name: string): string | null {
    return this.roles.get(name)?.prompt ?? null
  }

  getEmoji(name: string): string {
    return this.roles.get(name)?.emoji ?? '🤖'
  }

  has(name: string): boolean {
    return this.roles.has(name)
  }

  /**
   * Replace the registry with the `customRoles` in `config`.
   *
   * REPLACES rather than merges, and that is the load semantic a config file
   * has to have: a role the user deleted from `nexus.jsonc` must disappear on
   * the next reload, which an additive `register()` loop can never do. The
   * cost is that a role registered at runtime by the `roles.add` tool does not
   * survive a config reload — that tool is session-only and says so, and the
   * file is the only thing that persists a role.
   *
   * `customRoles` is typed `unknown` on purpose. The value arrives from
   * `JSON.parse`, so the file's shape is a claim about well-formed input, not a
   * guarantee — and this was the only reader of it, typed `any`, which is how
   * a malformed entry could reach `register()` and produce a role with an
   * `undefined` name. (That is the whole of the narrowing: the one field this
   * reads is now typed, and no other `any` in the config path was touched.)
   * Everything is validated here instead, and every entry that does not become
   * a role is reported rather than dropped: one `console.warn` per skipped
   * entry, plus the same facts in the returned report.
   *
   * DUPLICATE NAMES: the last entry wins, matching `register()`'s own
   * `Map.set` behaviour and the way a later object key overrides an earlier
   * one. The shadowed entry is reported, so a copy-paste that silently
   * replaces a role is visible.
   *
   * A role named after a BUILT-IN is allowed and wins: `buildRolePrompt`
   * consults this registry before the built-in prompt table, so overriding the
   * `coder` prompt is a legitimate power use, and nothing else about a built-in
   * (its model, its entry in the role lists) is affected by the name.
   */
  loadFromConfig(config: { readonly customRoles?: unknown }): CustomRoleLoadReport {
    const report: CustomRoleLoadReport = { registered: [], skipped: [] }
    this.roles.clear()

    const entries = config.customRoles
    if (entries === undefined) return report

    if (!Array.isArray(entries)) {
      report.skipped.push({ index: -1, name: null, reason: '"customRoles" is not an array' })
      console.warn('[nexus] Ignoring "customRoles": expected an array of role objects')
      return report
    }

    const seen = new Map<string, number>()
    for (const [index, entry] of (entries as readonly unknown[]).entries()) {
      const normalized = normalizeCustomRole(entry)
      if (!normalized.ok) {
        report.skipped.push({ index, name: normalized.name, reason: normalized.reason })
        console.warn(
          `[nexus] Skipping customRoles[${index}]: ${normalized.reason}`
        )
        continue
      }
      const { role } = normalized
      const shadowed = seen.get(role.name)
      if (shadowed !== undefined) {
        // The LATER entry wins, and the earlier one is the entry reported as
        // skipped — so the index in the report always points at a line the
        // user's own file has, and the report says which one is in effect.
        report.skipped.push({
          index: shadowed,
          name: role.name,
          reason: 'duplicate name; the later entry wins'
        })
        console.warn(
          `[nexus] customRoles[${shadowed}] is shadowed by customRoles[${index}]: both are named "${role.name}" and the later one wins`
        )
      } else {
        report.registered.push(role.name)
      }
      seen.set(role.name, index)
      this.register(role)
    }

    return report
  }
}
