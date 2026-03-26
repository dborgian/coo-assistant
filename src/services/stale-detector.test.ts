import { describe, it, expect } from "vitest";

describe("Stale Task Detection Logic", () => {
  function isStale(updatedAt: Date, thresholdDays: number): boolean {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - thresholdDays);
    return updatedAt <= threshold;
  }

  function getDaysStale(updatedAt: Date): number {
    return Math.floor(
      (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24),
    );
  }

  it("should detect task stale after 3 days", () => {
    const fourDaysAgo = new Date();
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
    expect(isStale(fourDaysAgo, 3)).toBe(true);
  });

  it("should NOT flag recently updated task", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isStale(yesterday, 3)).toBe(false);
  });

  it("should correctly calculate days stale", () => {
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    expect(getDaysStale(fiveDaysAgo)).toBe(5);
  });

  it("should flag critical tasks (7+ days)", () => {
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    expect(getDaysStale(tenDaysAgo)).toBeGreaterThanOrEqual(7);
  });

  it("should not flag 3-day-old as critical", () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    expect(getDaysStale(threeDaysAgo)).toBeLessThan(7);
  });
});
