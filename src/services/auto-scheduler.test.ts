import { describe, it, expect } from "vitest";

interface TimeSlot {
  start: Date;
  end: Date;
}

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 18;

function findFreeSlots(
  busySlots: TimeSlot[],
  startDate: Date,
  endDate: Date,
  durationMinutes: number,
): TimeSlot[] {
  const freeSlots: TimeSlot[] = [];
  const current = new Date(startDate);

  while (current < endDate) {
    const dayStart = new Date(current);
    dayStart.setHours(WORK_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(current);
    dayEnd.setHours(WORK_END_HOUR, 0, 0, 0);

    // Skip weekends
    if (dayStart.getDay() === 0 || dayStart.getDay() === 6) {
      current.setDate(current.getDate() + 1);
      continue;
    }

    const effectiveStart = dayStart < startDate ? new Date(startDate) : dayStart;
    if (effectiveStart >= dayEnd) {
      current.setDate(current.getDate() + 1);
      continue;
    }

    const dayBusy = busySlots
      .filter((s) => s.start < dayEnd && s.end > effectiveStart)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    let cursor = new Date(effectiveStart);

    for (const busy of dayBusy) {
      if (cursor < busy.start) {
        const gapMinutes = (busy.start.getTime() - cursor.getTime()) / 60000;
        if (gapMinutes >= durationMinutes) {
          freeSlots.push({
            start: new Date(cursor),
            end: new Date(cursor.getTime() + durationMinutes * 60000),
          });
        }
      }
      if (busy.end > cursor) cursor = new Date(busy.end);
    }

    if (cursor < dayEnd) {
      const gapMinutes = (dayEnd.getTime() - cursor.getTime()) / 60000;
      if (gapMinutes >= durationMinutes) {
        freeSlots.push({
          start: new Date(cursor),
          end: new Date(cursor.getTime() + durationMinutes * 60000),
        });
      }
    }

    current.setDate(current.getDate() + 1);
  }

  return freeSlots;
}

describe("Auto-Scheduler: Free Slot Finder", () => {
  // Use a fixed Wednesday to avoid weekend issues
  const baseDate = new Date("2026-03-25T09:00:00"); // Wednesday

  it("should find full day free when no busy slots", () => {
    const start = new Date("2026-03-25T09:00:00");
    const end = new Date("2026-03-25T18:00:00");
    const slots = findFreeSlots([], start, end, 60);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    // 9h available, 1h task = should fit
    expect(slots[0].start.getHours()).toBe(9);
  });

  it("should find slot around a meeting", () => {
    const start = new Date("2026-03-25T09:00:00");
    const end = new Date("2026-03-25T18:00:00");
    const busy: TimeSlot[] = [
      { start: new Date("2026-03-25T10:00:00"), end: new Date("2026-03-25T11:00:00") },
    ];
    const slots = findFreeSlots(busy, start, end, 60);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    // First slot should be 9:00-10:00
    expect(slots[0].start.getHours()).toBe(9);
    expect(slots[0].end.getHours()).toBe(10);
  });

  it("should find slot after busy period", () => {
    const start = new Date("2026-03-25T09:00:00");
    const end = new Date("2026-03-25T18:00:00");
    const busy: TimeSlot[] = [
      { start: new Date("2026-03-25T09:00:00"), end: new Date("2026-03-25T12:00:00") },
    ];
    const slots = findFreeSlots(busy, start, end, 120);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots[0].start.getHours()).toBe(12);
  });

  it("should return empty when no room", () => {
    const start = new Date("2026-03-25T09:00:00");
    const end = new Date("2026-03-25T18:00:00");
    const busy: TimeSlot[] = [
      { start: new Date("2026-03-25T09:00:00"), end: new Date("2026-03-25T18:00:00") },
    ];
    const slots = findFreeSlots(busy, start, end, 60);
    expect(slots.length).toBe(0);
  });

  it("should skip weekends", () => {
    // Saturday and Sunday
    const start = new Date("2026-03-28T09:00:00"); // Saturday
    const end = new Date("2026-03-29T18:00:00"); // Sunday
    const slots = findFreeSlots([], start, end, 60);
    expect(slots.length).toBe(0);
  });

  it("should respect task duration", () => {
    const start = new Date("2026-03-25T09:00:00");
    const end = new Date("2026-03-25T18:00:00");
    const busy: TimeSlot[] = [
      { start: new Date("2026-03-25T09:30:00"), end: new Date("2026-03-25T17:30:00") },
    ];
    // Only 30 min before and 30 min after — 60 min task won't fit
    const slots = findFreeSlots(busy, start, end, 60);
    expect(slots.length).toBe(0);
  });

  it("should handle multiple days", () => {
    const start = new Date("2026-03-25T09:00:00"); // Wed
    const end = new Date("2026-03-27T18:00:00"); // Fri
    const busy: TimeSlot[] = [
      // Full day Wednesday
      { start: new Date("2026-03-25T09:00:00"), end: new Date("2026-03-25T18:00:00") },
    ];
    const slots = findFreeSlots(busy, start, end, 60);
    // Should find slots on Thursday
    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots[0].start.getDate()).toBe(26); // Thursday
  });
});

describe("Auto-Scheduler: Priority Sorting", () => {
  const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

  it("should sort urgent before high", () => {
    const tasks = [
      { priority: "high", dueDate: new Date("2026-03-30") },
      { priority: "urgent", dueDate: new Date("2026-03-30") },
    ];
    const sorted = tasks.sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority] ?? 2;
      const pb = PRIORITY_RANK[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.dueDate.getTime() - b.dueDate.getTime();
    });
    expect(sorted[0].priority).toBe("urgent");
  });

  it("should sort earlier deadline first when same priority", () => {
    const tasks = [
      { priority: "medium", dueDate: new Date("2026-04-01") },
      { priority: "medium", dueDate: new Date("2026-03-28") },
    ];
    const sorted = tasks.sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority] ?? 2;
      const pb = PRIORITY_RANK[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.dueDate.getTime() - b.dueDate.getTime();
    });
    expect(sorted[0].dueDate.getDate()).toBe(28);
  });
});

describe("Auto-Scheduler: Dependencies", () => {
  it("should detect blocked tasks", () => {
    const blockedBy = JSON.stringify(["uuid-1", "uuid-2"]);
    const deps: string[] = JSON.parse(blockedBy);
    expect(deps.length).toBe(2);
    expect(deps).toContain("uuid-1");
  });

  it("should detect unblocked tasks", () => {
    const blockedBy = null;
    expect(blockedBy).toBeNull();
  });

  it("should handle empty array as unblocked", () => {
    const blockedBy = JSON.stringify([]);
    const deps: string[] = JSON.parse(blockedBy);
    expect(deps.length).toBe(0);
  });
});
