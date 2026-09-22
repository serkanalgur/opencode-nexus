import { spawn } from "node:child_process"

export interface NotificationOptions {
  title: string
  body: string
  sound?: boolean
  silent?: boolean
}

export class NotificationManager {
  private enabled: boolean
  private platform: string

  constructor(enabled: boolean = true) {
    this.enabled = enabled
    this.platform = process.platform
  }

  /**
   * Send an OS notification
   */
  async notify(options: NotificationOptions): Promise<boolean> {
    if (!this.enabled) return false

    try {
      if (this.platform === 'darwin') {
        return await this.notifyMacOS(options)
      } else if (this.platform === 'linux') {
        return await this.notifyLinux(options)
      } else if (this.platform === 'win32') {
        return await this.notifyWindows(options)
      }
    } catch {
      // Notifications are best-effort
    }
    return false
  }

  private async notifyMacOS(options: NotificationOptions): Promise<boolean> {
    const soundFlag = options.silent ? '' : (options.sound !== false ? 'sound name "Glass"' : '')
    const script = `display notification "${options.body}" with title "${options.title}" ${soundFlag}`

    return new Promise((resolve) => {
      const proc = spawn('osascript', ['-e', script])
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
      setTimeout(() => { proc.kill(); resolve(false) }, 3000)
    })
  }

  private async notifyLinux(options: NotificationOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('notify-send', [options.title, options.body])
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
      setTimeout(() => { proc.kill(); resolve(false) }, 3000)
    })
  }

  private async notifyWindows(options: NotificationOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('powershell', ['-Command', `New-BurntToastNotification -Text '${options.title}','${options.body}'`])
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
      setTimeout(() => { proc.kill(); resolve(false) }, 3000)
    })
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }
}
