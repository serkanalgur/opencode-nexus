import { describe, it, expect, beforeEach, mock } from "bun:test"
import { NotificationManager, type NotificationOptions } from "../src/notifications"

describe("NotificationManager", () => {
  let manager: NotificationManager

  beforeEach(() => {
    manager = new NotificationManager()
  })

  describe("constructor", () => {
    it("should create with default enabled state", () => {
      expect(manager.isEnabled()).toBe(true)
    })

    it("should create with disabled state", () => {
      const disabled = new NotificationManager(false)
      expect(disabled.isEnabled()).toBe(false)
    })
  })

  describe("setEnabled / isEnabled", () => {
    it("should toggle enabled state", () => {
      manager.setEnabled(false)
      expect(manager.isEnabled()).toBe(false)
      manager.setEnabled(true)
      expect(manager.isEnabled()).toBe(true)
    })
  })

  describe("notify", () => {
    it("should return false when disabled", async () => {
      manager.setEnabled(false)
      const result = await manager.notify({ title: "Test", body: "Hello" })
      expect(result).toBe(false)
    })

    it("should return a boolean when enabled", async () => {
      // Will return false on CI (no display), but should not throw
      const result = await manager.notify({ title: "Test", body: "Hello" })
      expect(typeof result).toBe("boolean")
    })

    it("should accept notification options", async () => {
      // Should not throw with any option combination
      const options: NotificationOptions[] = [
        { title: "Test", body: "Hello" },
        { title: "Test", body: "Hello", sound: true },
        { title: "Test", body: "Hello", sound: false },
        { title: "Test", body: "Hello", silent: true },
      ]
      for (const opts of options) {
        const result = await manager.notify(opts)
        expect(typeof result).toBe("boolean")
      }
    })

    it("should not crash on errors (best-effort)", async () => {
      // Even with invalid data, should not throw
      const result = await manager.notify({ title: "", body: "" })
      expect(typeof result).toBe("boolean")
    })
  })
})
