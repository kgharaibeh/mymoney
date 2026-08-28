/**
 * Rule-based auto-categorization. Pure and order-sensitive: the first rule
 * whose `match` appears (case-insensitively) in the payee wins. This is the
 * deterministic baseline; a learned/ML categorizer (Phase 2) can layer on top.
 */

import type { CategorizationRule } from "./types.js";

/** Return the categoryId of the first matching rule, or null if none match. */
export function categorize(payee: string, rules: CategorizationRule[]): string | null {
  const haystack = payee.toLowerCase();
  for (const rule of rules) {
    const needle = rule.match.trim().toLowerCase();
    if (needle.length > 0 && haystack.includes(needle)) return rule.categoryId;
  }
  return null;
}
