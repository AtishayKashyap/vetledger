import { describe, expect, it } from "vitest";
import { ageFrom, daysUntil, fmtDateTime, relativeDays } from "./format";

describe("format", () => {
  const now = new Date(2026, 5, 15, 13, 0); // 15 Jun 2026, local time
  it("counts calendar days regardless of the time of day", () => {
    expect(daysUntil("2026-06-15", now)).toBe(0);
    expect(daysUntil("2026-06-16", now)).toBe(1);
    expect(daysUntil("2026-06-10", now)).toBe(-5);
  });
  it("describes relative days", () => {
    expect([0, 1, -1, 4, -3].map(relativeDays)).toEqual(["today", "tomorrow", "yesterday", "in 4 days", "3 days overdue"]);
  });
  it("shows the year only when it isn't the current one", () => {
    expect(fmtDateTime("2026-03-04T10:00:00Z", now)).not.toMatch(/2026/);
    expect(fmtDateTime("2025-12-06T10:00:00Z", now)).toMatch(/2025/);
    expect(fmtDateTime(null, now)).toBe("—");
  });
  it("computes age in months then years", () => {
    expect(ageFrom("2026-01-20", now)).toBe("4 mo");
    expect(ageFrom("2023-06-16", now)).toBe("2 yr");
    expect(ageFrom(null, now)).toBe("—");
  });
});
