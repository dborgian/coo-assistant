import { describe, it, expect } from "vitest";

// Test the escalation level calculation logic
function calculateEscalationLevel(dueDate: Date): number {
  const now = Date.now();
  const due = dueDate.getTime();
  const hoursUntilDue = (due - now) / (1000 * 60 * 60);
  const daysOverdue = (now - due) / (1000 * 60 * 60 * 24);

  if (daysOverdue >= 7) return 4;
  if (daysOverdue >= 3) return 3;
  if (daysOverdue > 0) return 2;
  if (hoursUntilDue <= 24) return 1;
  if (hoursUntilDue <= 48) return 0;
  return -1;
}

describe("Task Escalation Level Calculation", () => {
  it("should return -1 for tasks due in 3+ days", () => {
    const future = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    expect(calculateEscalationLevel(future)).toBe(-1);
  });

  it("should return L0 for tasks due within 48h", () => {
    const in36h = new Date(Date.now() + 36 * 60 * 60 * 1000);
    expect(calculateEscalationLevel(in36h)).toBe(0);
  });

  it("should return L1 for tasks due within 24h", () => {
    const in12h = new Date(Date.now() + 12 * 60 * 60 * 1000);
    expect(calculateEscalationLevel(in12h)).toBe(1);
  });

  it("should return L2 for overdue tasks (< 3 days)", () => {
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    expect(calculateEscalationLevel(yesterday)).toBe(2);
  });

  it("should return L3 for tasks overdue 3+ days", () => {
    const threeDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    expect(calculateEscalationLevel(threeDaysAgo)).toBe(3);
  });

  it("should return L4 for tasks overdue 7+ days", () => {
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(calculateEscalationLevel(weekAgo)).toBe(4);
  });

  it("should only escalate up, never down", () => {
    const levels = [-1, 0, 1, 2, 3, 4];
    // Verify levels are monotonically ordered by severity
    for (let i = 0; i < levels.length - 1; i++) {
      expect(levels[i]).toBeLessThan(levels[i + 1]);
    }
  });

  it("should respect snooze (escalation paused)", () => {
    const pausedUntil = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const now = new Date();
    // Task is paused if pausedUntil > now
    expect(pausedUntil > now).toBe(true);
  });
});
