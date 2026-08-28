import { describe, it, expect } from "vitest";
import { categorize } from "./categorization.js";
import type { CategorizationRule } from "./types.js";

const rules: CategorizationRule[] = [
  { id: "1", userId: "u", match: "starbucks", categoryId: "coffee" },
  { id: "2", userId: "u", match: "shell", categoryId: "fuel" },
  { id: "3", userId: "u", match: "star", categoryId: "wrong-should-not-win" },
];

describe("categorize", () => {
  it("matches case-insensitively on a payee substring", () => {
    expect(categorize("STARBUCKS STORE #123", rules)).toBe("coffee");
    expect(categorize("Shell Gas Station", rules)).toBe("fuel");
  });
  it("returns the first matching rule in order", () => {
    // "starbucks" (rule 1) is checked before the broader "star" (rule 3)
    expect(categorize("starbucks", rules)).toBe("coffee");
  });
  it("returns null when nothing matches", () => {
    expect(categorize("Local Farmers Market", rules)).toBeNull();
  });
  it("ignores empty match strings", () => {
    expect(categorize("anything", [{ id: "x", userId: "u", match: "  ", categoryId: "c" }])).toBeNull();
  });
});
