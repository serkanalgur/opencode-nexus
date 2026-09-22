export interface SecurityIssue {
  id: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  category: string
  message: string
  file?: string
  line?: number
  suggestion?: string
}

export interface SecurityScanResult {
  issues: SecurityIssue[]
  score: number  // 0-100, higher is better
  scannedAt: Date
  filesScanned: number
}

export interface SecurityConfig {
  enabled: boolean
  scanSecrets: boolean
  scanPatterns: boolean
  customPatterns: RegExp[]
  excludeFiles: string[]
}

const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  scanSecrets: true,
  scanPatterns: true,
  customPatterns: [],
  excludeFiles: ['node_modules', '.git', 'dist', '*.test.ts', '*.spec.ts']
}

// Common secret patterns
const SECRET_PATTERNS: Array<{ pattern: RegExp; category: string; message: string }> = [
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]+['"]/gi, category: 'secrets', message: 'Possible API key found' },
  { pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi, category: 'secrets', message: 'Possible password/secret found' },
  { pattern: /(?:token|access_token|auth_token)\s*[:=]\s*['"][^'"]+['"]/gi, category: 'secrets', message: 'Possible token found' },
  { pattern: /(?:private[_-]?key)\s*[:=]\s*['"][^'"]+['"]/gi, category: 'secrets', message: 'Possible private key found' },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, category: 'secrets', message: 'Private key block found' },
  { pattern: /(?:AWS|aws)(?:_ACCESS_KEY_ID|_SECRET_ACCESS_KEY)\s*[:=]\s*['"][^'"]+['"]/gi, category: 'secrets', message: 'AWS credentials found' },
]

// Dangerous code patterns
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; category: string; message: string; suggestion: string }> = [
  { pattern: /eval\s*\(/g, category: 'injection', message: 'eval() usage detected', suggestion: 'Use safer alternatives like JSON.parse() or Function constructor' },
  { pattern: /exec\s*\(/g, category: 'injection', message: 'exec() usage detected', suggestion: 'Use execFile() or spawn() with argument arrays' },
  { pattern: /child_process/g, category: 'injection', message: 'child_process usage detected', suggestion: 'Ensure user input is sanitized before shell execution' },
  { pattern: /innerHTML\s*=/g, category: 'xss', message: 'innerHTML assignment detected', suggestion: 'Use textContent or sanitize input before setting innerHTML' },
  { pattern: /document\.write\s*\(/g, category: 'xss', message: 'document.write() usage detected', suggestion: 'Use DOM manipulation methods instead' },
  { pattern: /new Function\s*\(/g, category: 'injection', message: 'Function constructor usage detected', suggestion: 'Avoid dynamic code execution' },
  { pattern: /__proto__\s*=/g, category: 'prototype-pollution', message: '__proto__ assignment detected', suggestion: 'Use Object.create() or Object.assign() instead' },
  { pattern: /process\.env\[?[\"'][^\"']+[\"']\]?(?!\.replace)/g, category: 'data-exposure', message: 'Direct process.env access', suggestion: 'Use a config module with validation' },
]

export class SecurityScanner {
  private config: SecurityConfig
  private issues: SecurityIssue[] = []

  constructor(config?: Partial<SecurityConfig>) {
    this.config = { ...DEFAULT_SECURITY_CONFIG, ...config }
  }

  /**
   * Scan code content for security issues
   */
  scanContent(content: string, filename: string): SecurityIssue[] {
    if (!this.config.enabled) return []

    // Check exclusions
    if (this.isExcluded(filename)) return []

    const issues: SecurityIssue[] = []

    // Scan for secrets
    if (this.config.scanSecrets) {
      for (const { pattern, category, message } of SECRET_PATTERNS) {
        const matches = content.matchAll(new RegExp(pattern.source, pattern.flags))
        for (const match of matches) {
          const line = this.getLineNumber(content, match.index || 0)
          issues.push({
            id: `sec-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            severity: 'critical',
            category,
            message,
            file: filename,
            line,
            suggestion: 'Remove hardcoded secrets and use environment variables or a secrets manager'
          })
        }
      }
    }

    // Scan for dangerous patterns
    if (this.config.scanPatterns) {
      for (const { pattern, category, message, suggestion } of DANGEROUS_PATTERNS) {
        const matches = content.matchAll(new RegExp(pattern.source, pattern.flags))
        for (const match of matches) {
          const line = this.getLineNumber(content, match.index || 0)
          issues.push({
            id: `sec-${Date.now()}-${Math.random().toString(36).substr(6, 6)}`,
            severity: 'medium',
            category,
            message,
            file: filename,
            line,
            suggestion
          })
        }
      }
    }

    // Custom patterns
    for (const pattern of this.config.customPatterns) {
      const matches = content.matchAll(new RegExp(pattern.source, pattern.flags))
      for (const match of matches) {
        const line = this.getLineNumber(content, match.index || 0)
        issues.push({
          id: `sec-${Date.now()}-${Math.random().toString(36).substr(12, 6)}`,
          severity: 'medium',
          category: 'custom',
          message: `Custom pattern match in ${filename}`,
          file: filename,
          line
        })
      }
    }

    this.issues.push(...issues)
    return issues
  }

  /**
   * Generate a scan result summary
   */
  getResult(): SecurityScanResult {
    const severityScores = { critical: 0, high: 10, medium: 25, low: 50 }
    let deductions = 0
    for (const issue of this.issues) {
      deductions += severityScores[issue.severity] || 25
    }
    const score = Math.max(0, 100 - deductions)

    return {
      issues: [...this.issues],
      score,
      scannedAt: new Date(),
      filesScanned: new Set(this.issues.map(i => i.file).filter(Boolean)).size || 0
    }
  }

  /**
   * Get issues by severity
   */
  getBySeverity(severity: SecurityIssue['severity']): SecurityIssue[] {
    return this.issues.filter(i => i.severity === severity)
  }

  /**
   * Get issues by category
   */
  getByCategory(category: string): SecurityIssue[] {
    return this.issues.filter(i => i.category === category)
  }

  /**
   * Check if file should be excluded
   */
  private isExcluded(filename: string): boolean {
    return this.config.excludeFiles.some(exclusion => {
      if (exclusion.startsWith('*')) {
        return filename.endsWith(exclusion.slice(1))
      }
      return filename.includes(exclusion)
    })
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length
  }

  clear(): void {
    this.issues = []
  }

  getStats(): { total: number; critical: number; high: number; medium: number; low: number } {
    return {
      total: this.issues.length,
      critical: this.getBySeverity('critical').length,
      high: this.getBySeverity('high').length,
      medium: this.getBySeverity('medium').length,
      low: this.getBySeverity('low').length
    }
  }
}
