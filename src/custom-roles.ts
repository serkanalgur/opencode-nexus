export interface CustomRole {
  name: string
  displayName: string
  emoji: string
  prompt: string
  model?: string  // default model for this role
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

  loadFromConfig(config: any): void {
    if (config.customRoles && Array.isArray(config.customRoles)) {
      for (const role of config.customRoles) {
        this.register(role)
      }
    }
  }
}
