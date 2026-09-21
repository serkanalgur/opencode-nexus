# Contributing to OpenCode Nexus

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.4.0
- [Node.js](https://nodejs.org) >= 22.0.0
- [Git](https://git-scm.com)

### Development Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/serkanalgur/opencode-nexus.git
cd opencode-nexus
```

2. **Install dependencies**

```bash
bun install
```

3. **Start development**

```bash
bun run dev
```

4. **Run tests**

```bash
bun test
```

## 📁 Project Structure

```
opencode-nexus/
├── src/
│   ├── index.ts          # Plugin entry point
│   ├── orchestrator.ts   # Core orchestrator logic
│   ├── types.ts          # TypeScript type definitions
│   └── tui.tsx           # TUI components
├── assets/
│   └── banner.svg        # GitHub banner
├── tests/                # Test files
├── package.json
├── tsconfig.json
└── README.md
```

## 🔧 Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:

- `feat/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Adding tests

Example: `feat/add-cost-dashboard`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add real-time cost tracking
fix: resolve agent timeout issue
docs: update API reference
refactor: simplify DAG executor
test: add unit tests for cost router
```

### Code Style

- Use TypeScript strict mode
- Follow the existing code style
- Run `bun run format` before committing
- Run `bun run lint` to check for issues

### Testing

- Write tests for new features
- Ensure all tests pass before submitting PR
- Aim for high test coverage

```bash
bun test                    # Run all tests
bun test --coverage         # Run with coverage
```

## 🎯 Contributing Guidelines

### Adding a New Module

1. Create a new file in `src/modules/`
2. Implement the `NexusModule` interface
3. Add tests in `tests/modules/`
4. Update documentation
5. Register the module in the orchestrator

### Adding a New Tool

1. Add tool definition in `src/tools/`
2. Register in `src/index.ts`
3. Add to README documentation
4. Write tests

### Bug Reports

When filing an issue, please include:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)
- Relevant logs or error messages

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Add/update tests
4. Update documentation if needed
5. Submit PR with clear description

## 📝 Documentation

- Update README.md for user-facing changes
- Update API.md for API changes
- Add inline comments for complex logic
- Include examples for new features

## 🧪 Testing

### Unit Tests

Test individual functions and classes:

```typescript
import { describe, it, expect } from 'bun:test'
import { NexusOrchestrator } from '../src/orchestrator'

describe('NexusOrchestrator', () => {
  it('should spawn agents with real sessions', async () => {
    const orchestrator = new NexusOrchestrator()
    // Initialize with mock context for testing
    orchestrator.initialize(mockCtx)
    const agent = await orchestrator.spawnAgent({ role: 'coder' })
    expect(agent).toBeDefined()
    expect(agent.role).toBe('coder')
    expect(agent.sessionID).toBeDefined()
  })
})
```

### Integration Tests

Test module interactions:

```typescript
describe('CostRoutingModule + DAG', () => {
  it('should select cost-appropriate models', async () => {
    // Test cost routing with DAG execution
  })
})
```

## 🎨 Design Principles

1. **Modularity** - Keep modules independent and composable
2. **Type Safety** - Leverage TypeScript's type system
3. **Error Handling** - Graceful degradation and recovery
4. **Performance** - Optimize for real-time operations
5. **Documentation** - Clear and comprehensive docs

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 💬 Questions?

Feel free to open an issue for questions or discussions!
