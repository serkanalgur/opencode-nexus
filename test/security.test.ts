import { describe, it, expect, beforeEach } from "bun:test"
import { SecurityScanner } from "../src/security"

describe("SecurityScanner", () => {
  let scanner: SecurityScanner

  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  describe("constructor", () => {
    it("should create with default config", () => {
      expect(scanner).toBeDefined()
      const stats = scanner.getStats()
      expect(stats.total).toBe(0)
    })

    it("should create with custom config", () => {
      const customScanner = new SecurityScanner({
        enabled: false,
        scanSecrets: false
      })
      expect(customScanner).toBeDefined()
    })
  })

  describe("scanContent", () => {
    it("should return empty array for clean code", () => {
      const issues = scanner.scanContent("const x = 1;", "clean.ts")
      expect(issues).toHaveLength(0)
    })

    it("should detect API keys", () => {
      const content = `const apiKey = "sk-1234567890abcdef";`
      const issues = scanner.scanContent(content, "config.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("secrets")
      expect(issues[0].severity).toBe("critical")
      expect(issues[0].message).toContain("API key")
    })

    it("should detect passwords", () => {
      const content = `const password = "supersecret123";`
      const issues = scanner.scanContent(content, "auth.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("secrets")
      expect(issues[0].message).toContain("password")
    })

    it("should detect tokens", () => {
      const content = `const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";`
      const issues = scanner.scanContent(content, "auth.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("secrets")
      expect(issues[0].message).toContain("token")
    })

    it("should detect private keys", () => {
      const content = `const privateKey = "-----BEGIN RSA PRIVATE KEY-----";`
      const issues = scanner.scanContent(content, "crypto.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("secrets")
    })

    it("should detect AWS credentials", () => {
      const content = `const AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";`
      const issues = scanner.scanContent(content, "aws.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("secrets")
      expect(issues[0].message).toContain("AWS")
    })

    it("should detect eval() usage", () => {
      const content = `eval("alert('xss')");`
      const issues = scanner.scanContent(content, "dangerous.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("injection")
      expect(issues[0].severity).toBe("medium")
      expect(issues[0].suggestion).toBeDefined()
    })

    it("should detect innerHTML assignment", () => {
      const content = `element.innerHTML = userInput;`
      const issues = scanner.scanContent(content, "ui.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("xss")
      expect(issues[0].message).toContain("innerHTML")
    })

    it("should detect prototype pollution", () => {
      const content = `obj.__proto__ = malicious;`
      const issues = scanner.scanContent(content, "pollution.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("prototype-pollution")
    })

    it("should detect process.env access", () => {
      const content = `const value = process.env["SECRET_KEY"];`
      const issues = scanner.scanContent(content, "config.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("data-exposure")
    })

    it("should exclude test files by default", () => {
      const content = `const apiKey = "sk-1234567890abcdef";`
      const issues = scanner.scanContent(content, "config.test.ts")
      expect(issues).toHaveLength(0)
    })

    it("should exclude node_modules", () => {
      const content = `const apiKey = "sk-1234567890abcdef";`
      const issues = scanner.scanContent(content, "node_modules/package/config.ts")
      expect(issues).toHaveLength(0)
    })

    it("should exclude spec files", () => {
      const content = `const apiKey = "sk-1234567890abcdef";`
      const issues = scanner.scanContent(content, "config.spec.ts")
      expect(issues).toHaveLength(0)
    })

    it("should skip scanning when disabled", () => {
      const disabledScanner = new SecurityScanner({ enabled: false })
      const content = `const apiKey = "sk-1234567890abcdef";`
      const issues = disabledScanner.scanContent(content, "config.ts")
      expect(issues).toHaveLength(0)
    })

    it("should skip secrets scanning when disabled", () => {
      const noSecretsScanner = new SecurityScanner({ scanSecrets: false })
      const content = `const apiKey = "sk-1234567890abcdef";`
      const issues = noSecretsScanner.scanContent(content, "config.ts")
      expect(issues).toHaveLength(0)
    })

    it("should skip patterns scanning when disabled", () => {
      const noPatternsScanner = new SecurityScanner({ scanPatterns: false })
      const content = `eval("alert('xss')");`
      const issues = noPatternsScanner.scanContent(content, "dangerous.ts")
      expect(issues).toHaveLength(0)
    })

    it("should detect custom patterns", () => {
      const customScanner = new SecurityScanner({
        customPatterns: [/TODO: fix security/gi]
      })
      const content = `// TODO: fix security vulnerability`
      const issues = customScanner.scanContent(content, "todo.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].category).toBe("custom")
    })

    it("should track multiple issues across scans", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "file1.ts")
      scanner.scanContent(`eval("alert('xss')");`, "file2.ts")

      const result = scanner.getResult()
      expect(result.issues.length).toBeGreaterThan(0)
      expect(result.filesScanned).toBe(2)
    })
  })

  describe("getResult", () => {
    it("should return score of 100 for clean content", () => {
      scanner.scanContent("const x = 1;", "clean.ts")
      const result = scanner.getResult()
      expect(result.score).toBe(100)
    })

    it("should reduce score for critical issues", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "config.ts")
      const result = scanner.getResult()
      expect(result.score).toBeLessThan(100)
    })

    it("should return issues list", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "config.ts")
      const result = scanner.getResult()
      expect(result.issues.length).toBeGreaterThan(0)
    })

    it("should return scannedAt timestamp", () => {
      const result = scanner.getResult()
      expect(result.scannedAt).toBeInstanceOf(Date)
    })

    it("should calculate filesScanned correctly", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "file1.ts")
      scanner.scanContent(`const password = "secret123";`, "file2.ts")
      const result = scanner.getResult()
      expect(result.filesScanned).toBe(2)
    })
  })

  describe("getBySeverity", () => {
    it("should filter issues by severity", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "config.ts")
      scanner.scanContent(`eval("alert('xss')");`, "dangerous.ts")

      const critical = scanner.getBySeverity("critical")
      const medium = scanner.getBySeverity("medium")

      expect(critical.length).toBeGreaterThan(0)
      expect(medium.length).toBeGreaterThan(0)
      expect(critical.every(i => i.severity === "critical")).toBe(true)
      expect(medium.every(i => i.severity === "medium")).toBe(true)
    })
  })

  describe("getByCategory", () => {
    it("should filter issues by category", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "config.ts")
      scanner.scanContent(`eval("alert('xss')");`, "dangerous.ts")

      const secrets = scanner.getByCategory("secrets")
      const injection = scanner.getByCategory("injection")

      expect(secrets.length).toBeGreaterThan(0)
      expect(injection.length).toBeGreaterThan(0)
      expect(secrets.every(i => i.category === "secrets")).toBe(true)
      expect(injection.every(i => i.category === "injection")).toBe(true)
    })
  })

  describe("clear", () => {
    it("should clear all issues", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "config.ts")
      expect(scanner.getStats().total).toBeGreaterThan(0)

      scanner.clear()
      expect(scanner.getStats().total).toBe(0)
    })
  })

  describe("getStats", () => {
    it("should return correct stats", () => {
      scanner.scanContent(`const apiKey = "sk-1234567890abcdef";`, "config.ts")
      scanner.scanContent(`eval("alert('xss')");`, "dangerous.ts")

      const stats = scanner.getStats()
      expect(stats.total).toBeGreaterThan(0)
      expect(stats.critical).toBeGreaterThan(0)
      expect(stats.medium).toBeGreaterThan(0)
      expect(stats.high).toBe(0)
      expect(stats.low).toBe(0)
    })
  })

  describe("line number tracking", () => {
    it("should track correct line numbers", () => {
      const content = `// Line 1\n// Line 2\nconst apiKey = "sk-1234567890abcdef";`
      const issues = scanner.scanContent(content, "config.ts")
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].line).toBe(3)
    })

    it("should track line numbers for multiple issues", () => {
      const content = `const apiKey = "sk-1234567890abcdef";\nconst password = "secret123";`
      const issues = scanner.scanContent(content, "config.ts")
      expect(issues.length).toBe(2)
      expect(issues[0].line).toBe(1)
      expect(issues[1].line).toBe(2)
    })
  })

  describe("issue IDs", () => {
    it("should generate unique issue IDs", () => {
      const content = `const apiKey = "sk-1234567890abcdef";`
      scanner.scanContent(content, "config.ts")
      scanner.scanContent(content, "config2.ts")

      const result = scanner.getResult()
      const ids = result.issues.map(i => i.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })
})
