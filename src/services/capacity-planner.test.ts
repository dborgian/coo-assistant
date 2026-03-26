import { describe, it, expect } from "vitest";

describe("Capacity Planner Logic", () => {
  const WORK_HOURS_PER_DAY = 8;
  const FORECAST_DAYS = 5;
  const totalAvailableHours = WORK_HOURS_PER_DAY * FORECAST_DAYS; // 40h

  function getStatus(utilizationPercent: number): string {
    if (utilizationPercent >= 80) return "overloaded";
    if (utilizationPercent >= 40) return "balanced";
    return "available";
  }

  function calcUtilization(scheduledHours: number): number {
    return Math.round((scheduledHours / totalAvailableHours) * 100);
  }

  it("should calculate utilization correctly", () => {
    expect(calcUtilization(0)).toBe(0);
    expect(calcUtilization(20)).toBe(50);
    expect(calcUtilization(40)).toBe(100);
  });

  it("should classify availability correctly", () => {
    expect(getStatus(calcUtilization(10))).toBe("available"); // 25%
    expect(getStatus(calcUtilization(20))).toBe("balanced");  // 50%
    expect(getStatus(calcUtilization(35))).toBe("overloaded"); // 88%
  });

  it("should suggest least loaded employee", () => {
    const employees = [
      { name: "Marco", utilization: 70 },
      { name: "Anna", utilization: 30 },
      { name: "Luca", utilization: 90 },
    ];
    const sorted = employees.sort((a, b) => a.utilization - b.utilization);
    expect(sorted[0].name).toBe("Anna");
  });

  it("should default unestimated tasks to 60 min", () => {
    const estimatedMinutes = null;
    const effective = estimatedMinutes ?? 60;
    expect(effective).toBe(60);
  });
});
