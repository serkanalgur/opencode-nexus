/**
 * Composable Module Architecture for Nexus
 *
 * Modules can be registered with lifecycle hooks, tools, and event handlers.
 * They are set up during orchestrator initialization and torn down on shutdown.
 */

export interface NexusModule {
  name: string
  description: string
  version: string

  // Lifecycle hooks
  setup?: (ctx: ModuleContext) => Promise<void>
  teardown?: () => Promise<void>

  // Optional: expose tools, hooks, or extensions
  tools?: ModuleTool[]
  hooks?: ModuleHook[]
}

export interface ModuleContext {
  orchestrator: any // NexusOrchestrator
  config: any       // NexusFullConfig
  emit: (event: string, data: any) => void
  on: (event: string, handler: (data: any) => void) => void
}

export interface ModuleTool {
  name: string
  description: string
  execute: (input: any) => Promise<{ content: string }>
}

export interface ModuleHook {
  event: string
  handler: (data: any) => void | Promise<void>
}

export class ModuleRegistry {
  private modules: Map<string, NexusModule> = new Map()
  private contexts: Map<string, ModuleContext> = new Map()

  register(module: NexusModule): void {
    if (this.modules.has(module.name)) {
      throw new Error(`Module '${module.name}' is already registered`)
    }
    this.modules.set(module.name, module)
  }

  async setupAll(ctx: ModuleContext): Promise<void> {
    for (const [name, module] of this.modules) {
      try {
        if (module.setup) {
          await module.setup(ctx)
          this.contexts.set(name, ctx)
        }
        // Register hooks
        if (module.hooks) {
          for (const hook of module.hooks) {
            ctx.on(hook.event, hook.handler)
          }
        }
      } catch (err) {
        console.error(`[nexus] Failed to setup module '${name}':`, err)
      }
    }
  }

  async teardownAll(): Promise<void> {
    for (const [name, module] of this.modules) {
      try {
        if (module.teardown) {
          await module.teardown()
        }
      } catch (err) {
        console.error(`[nexus] Failed to teardown module '${name}':`, err)
      }
    }
    this.contexts.clear()
  }

  get(name: string): NexusModule | undefined {
    return this.modules.get(name)
  }

  list(): NexusModule[] {
    return [...this.modules.values()]
  }

  getTools(): ModuleTool[] {
    const tools: ModuleTool[] = []
    for (const module of this.modules.values()) {
      if (module.tools) {
        tools.push(...module.tools)
      }
    }
    return tools
  }

  isRegistered(name: string): boolean {
    return this.modules.has(name)
  }

  unregister(name: string): boolean {
    this.contexts.delete(name)
    return this.modules.delete(name)
  }
}
