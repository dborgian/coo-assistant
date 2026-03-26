import { describe, it, expect } from "vitest";

describe("Workload Score Calculation", () => {
  function calculateWorkloadScore(
    tasksAssigned: number,
    tasksOverdue: number,
    avgCompletionDays: number | null,
  ): number {
    const rawScore =
      tasksAssigned * 0.4 + tasksOverdue * 0.3 + (avgCompletionDays ?? 0) * 0.3;
    return Math.min(1, rawScore / 10);
  }

  it("should return 0 for no tasks", () => {
    expect(calculateWorkloadScore(0, 0, null)).toBe(0);
  });

  it("should increase with more assigned tasks", () => {
    const low = calculateWorkloadScore(2, 0, null);
    const high = calculateWorkloadScore(10, 0, null);
    expect(high).toBeGreaterThan(low);
  });

  it("should increase with overdue tasks", () => {
    const noOverdue = calculateWorkloadScore(5, 0, null);
    const withOverdue = calculateWorkloadScore(5, 3, null);
    expect(withOverdue).toBeGreaterThan(noOverdue);
  });

  it("should cap at 1.0", () => {
    expect(calculateWorkloadScore(100, 50, 30)).toBe(1);
  });

  it("should give balanced score for moderate load", () => {
    const score = calculateWorkloadScore(5, 1, 3);
    // (5*0.4 + 1*0.3 + 3*0.3) / 10 = (2 + 0.3 + 0.9) / 10 = 0.32
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(0.5);
  });
});

describe("Capacity Status Classification", () => {
  function getStatus(utilizationPercent: number): string {
    if (utilizationPercent >= 80) return "overloaded";
    if (utilizationPercent >= 40) return "balanced";
    return "available";
  }

  it("should be available at low utilization", () => {
    expect(getStatus(0)).toBe("available");
    expect(getStatus(20)).toBe("available");
    expect(getStatus(39)).toBe("available");
  });

  it("should be balanced at moderate utilization", () => {
    expect(getStatus(40)).toBe("balanced");
    expect(getStatus(60)).toBe("balanced");
    expect(getStatus(79)).toBe("balanced");
  });

  it("should be overloaded at high utilization", () => {
    expect(getStatus(80)).toBe("overloaded");
    expect(getStatus(100)).toBe("overloaded");
    expect(getStatus(150)).toBe("overloaded");
  });
});
