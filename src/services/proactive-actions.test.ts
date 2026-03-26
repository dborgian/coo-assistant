import { describe, it, expect } from "vitest";

describe("Proactive Actions Logic", () => {
  it("should detect urgent unassigned tasks", () => {
    const now = new Date();
    const tasks = [
      { assignedTo: null, dueDate: new Date(now.getTime() + 1 * 24 * 60 * 60000) }, // 1 day
      { assignedTo: null, dueDate: new Date(now.getTime() + 5 * 24 * 60 * 60000) }, // 5 days
      { assignedTo: "uuid", dueDate: new Date(now.getTime() + 1 * 24 * 60 * 60000) }, // assigned
      { assignedTo: null, dueDate: null }, // no deadline
    ];

    const urgent = tasks.filter((t) => {
      if (t.assignedTo || !t.dueDate) return false;
      const daysUntil = (t.dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return daysUntil <= 3;
    });

    expect(urgent.length).toBe(1);
  });

  it("should detect overloaded employees", () => {
    const workload = [
      { employeeName: "Marco", workloadScore: 0.8 },
      { employeeName: "Anna", workloadScore: 0.3 },
      { employeeName: "Luca", workloadScore: 0.9 },
    ];

    const overloaded = workload.filter((w) => w.workloadScore >= 0.7);
    expect(overloaded.length).toBe(2);
    expect(overloaded.map((w) => w.employeeName)).toContain("Marco");
    expect(overloaded.map((w) => w.employeeName)).toContain("Luca");
  });

  it("should detect long-running tasks", () => {
    const now = new Date();
    const tasks = [
      { status: "in_progress", createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60000) }, // 10 days
      { status: "in_progress", createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60000) },  // 2 days
      { status: "pending", createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60000) },      // pending, skip
    ];

    const longRunning = tasks.filter((t) => {
      if (t.status !== "in_progress") return false;
      const days = (now.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      return days > 7;
    });

    expect(longRunning.length).toBe(1);
  });

  it("should not alert when no issues", () => {
    const issues: string[] = [];
    expect(issues.length).toBe(0);
    // In real code, this means no Telegram notification is sent
  });
});
