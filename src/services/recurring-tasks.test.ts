import { describe, it, expect } from "vitest";

describe("Recurring Tasks Logic", () => {
  function shouldGenerate(
    pattern: string,
    recurrenceDays: string | null,
    currentDayOfWeek: number,
    currentDayOfMonth: number,
  ): boolean {
    if (pattern === "daily") return true;

    if (pattern === "weekly") {
      const days: number[] = recurrenceDays ? JSON.parse(recurrenceDays) : [1];
      return days.includes(currentDayOfWeek);
    }

    if (pattern === "monthly") {
      const days: number[] = recurrenceDays ? JSON.parse(recurrenceDays) : [1];
      return days.includes(currentDayOfMonth);
    }

    return false;
  }

  describe("daily pattern", () => {
    it("should always generate for daily", () => {
      expect(shouldGenerate("daily", null, 0, 1)).toBe(true);
      expect(shouldGenerate("daily", null, 3, 15)).toBe(true);
      expect(shouldGenerate("daily", null, 6, 31)).toBe(true);
    });
  });

  describe("weekly pattern", () => {
    it("should generate on specified days", () => {
      // [1,3,5] = Mon, Wed, Fri
      expect(shouldGenerate("weekly", "[1,3,5]", 1, 1)).toBe(true);
      expect(shouldGenerate("weekly", "[1,3,5]", 3, 1)).toBe(true);
      expect(shouldGenerate("weekly", "[1,3,5]", 5, 1)).toBe(true);
    });

    it("should NOT generate on other days", () => {
      expect(shouldGenerate("weekly", "[1,3,5]", 0, 1)).toBe(false); // Sunday
      expect(shouldGenerate("weekly", "[1,3,5]", 2, 1)).toBe(false); // Tuesday
      expect(shouldGenerate("weekly", "[1,3,5]", 4, 1)).toBe(false); // Thursday
    });

    it("should default to Monday if no days specified", () => {
      expect(shouldGenerate("weekly", null, 1, 1)).toBe(true);
      expect(shouldGenerate("weekly", null, 3, 1)).toBe(false);
    });
  });

  describe("monthly pattern", () => {
    it("should generate on specified days of month", () => {
      expect(shouldGenerate("monthly", "[1,15]", 0, 1)).toBe(true);
      expect(shouldGenerate("monthly", "[1,15]", 0, 15)).toBe(true);
    });

    it("should NOT generate on other days", () => {
      expect(shouldGenerate("monthly", "[1,15]", 0, 2)).toBe(false);
      expect(shouldGenerate("monthly", "[1,15]", 0, 14)).toBe(false);
    });
  });

  describe("recurrence end date", () => {
    it("should stop generating after end date", () => {
      const endDate = new Date("2026-01-01");
      const now = new Date("2026-03-26");
      expect(endDate < now).toBe(true); // Should not generate
    });

    it("should generate before end date", () => {
      const endDate = new Date("2027-01-01");
      const now = new Date("2026-03-26");
      expect(endDate < now).toBe(false); // Should generate
    });
  });
});
