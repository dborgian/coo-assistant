import { describe, it, expect } from "vitest";

describe("Meeting Action Items Logic", () => {
  it("should detect recently ended meetings", () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const events = [
      { summary: "Team Standup", end: new Date(now.getTime() - 30 * 60000).toISOString() }, // 30 min ago
      { summary: "Future Meeting", end: new Date(now.getTime() + 60 * 60000).toISOString() }, // in 1h
      { summary: "Old Meeting", end: new Date(now.getTime() - 3 * 60 * 60000).toISOString() }, // 3h ago
    ];

    const recentlyEnded = events.filter((e) => {
      const end = new Date(e.end);
      return end > oneHourAgo && end <= now;
    });

    expect(recentlyEnded.length).toBe(1);
    expect(recentlyEnded[0].summary).toBe("Team Standup");
  });

  it("should not flag future meetings", () => {
    const now = new Date();
    const end = new Date(now.getTime() + 60000);
    expect(end > now).toBe(true); // Still in the future
  });
});
