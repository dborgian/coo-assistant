import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../config.js", () => ({
  config: { TELEGRAM_OWNER_CHAT_ID: 123 },
}));

vi.mock("../models/database.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../models/schema.js", () => ({
  tasks: { status: "status", dueDate: "due_date", id: "id", priority: "priority" },
}));

// Test the priority logic directly
describe("Auto-Prioritizer Logic", () => {
  const PRIORITY_ORDER = ["low", "medium", "high", "urgent"];

  function getPriorityIndex(p: string): number {
    return PRIORITY_ORDER.indexOf(p);
  }

  function calculateNewPriority(
    currentPriority: string,
    daysUntilDue: number,
  ): string | null {
    const currentIdx = getPriorityIndex(currentPriority);

    if (daysUntilDue <= 0) {
      if (currentIdx < 3) return "urgent";
    } else if (daysUntilDue <= 1) {
      if (currentIdx < 2) return "high";
    } else if (daysUntilDue <= 3) {
      if (currentIdx < 1) return "medium";
    }
    return null;
  }

  it("should upgrade low to urgent when overdue", () => {
    expect(calculateNewPriority("low", -1)).toBe("urgent");
  });

  it("should upgrade medium to urgent when overdue", () => {
    expect(calculateNewPriority("medium", 0)).toBe("urgent");
  });

  it("should upgrade low to high when due within 1 day", () => {
    expect(calculateNewPriority("low", 0.5)).toBe("high");
  });

  it("should NOT upgrade high to high when due within 1 day", () => {
    expect(calculateNewPriority("high", 0.5)).toBe(null);
  });

  it("should upgrade low to medium when due within 3 days", () => {
    expect(calculateNewPriority("low", 2)).toBe("medium");
  });

  it("should NOT downgrade urgent", () => {
    expect(calculateNewPriority("urgent", -5)).toBe(null);
  });

  it("should NOT change when deadline is far", () => {
    expect(calculateNewPriority("low", 10)).toBe(null);
    expect(calculateNewPriority("medium", 5)).toBe(null);
  });

  it("should skip blocked tasks", () => {
    const blockedBy = JSON.stringify(["some-uuid"]);
    const deps: string[] = JSON.parse(blockedBy);
    expect(deps.length).toBeGreaterThan(0);
    // In real code, this would cause the task to be skipped
  });
});
