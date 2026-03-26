import { describe, it, expect } from "vitest";

describe("Client Updates Logic", () => {
  it("should filter recently completed tasks", () => {
    const now = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const tasks = [
      { status: "done", updatedAt: new Date(now.getTime() - 2 * 24 * 60 * 60000) }, // 2 days ago
      { status: "done", updatedAt: new Date(now.getTime() - 10 * 24 * 60 * 60000) }, // 10 days ago
      { status: "pending", updatedAt: now },
    ];

    const completedRecently = tasks.filter((t) => {
      if (t.status !== "done") return false;
      return t.updatedAt >= weekAgo;
    });

    expect(completedRecently.length).toBe(1);
  });

  it("should skip clients without email", () => {
    const clients = [
      { name: "Acme", email: "acme@test.com" },
      { name: "Beta", email: null },
      { name: "Gamma", email: "" },
    ];

    const withEmail = clients.filter((c) => !!c.email);
    expect(withEmail.length).toBe(1);
    expect(withEmail[0].name).toBe("Acme");
  });
});
