import type { GroupedItem, GroupedListGroup } from "./GroupedList.js";

/** Subsequence match: every char of q appears in target in order. */
export function subsequence(target: string, q: string): boolean {
  if (!q) return true;
  const t = target.toLowerCase();
  const qq = q.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < qq.length; i++) {
    if (t[i] === qq[qi]) qi++;
  }
  return qi === qq.length;
}

/** Token match: substring first, then subsequence fallback. */
export function tokenMatches(target: string, q: string): boolean {
  if (!q) return true;
  const t = target.toLowerCase();
  const qq = q.toLowerCase();
  return t.includes(qq) || subsequence(target, q);
}

/**
 * Fuzzy-filter grouped data. Rules:
 *  - empty query       → return groups unchanged
 *  - `provider/model`  → provider matches left, item matches right
 *  - single token      → match against group label, item label, or combined
 *
 * When the query is non-empty, groups with zero surviving items are dropped.
 * Pass the full groups back (including empty ones) when the query is empty so
 * UI like "no key" provider headers stay visible.
 */
export function fuzzyFilterGroups<Item extends GroupedItem>(
  groups: GroupedListGroup<Item>[],
  query: string,
): GroupedListGroup<Item>[] {
  const q = query.trim();
  if (!q) return groups;
  const hasSlash = q.includes("/");
  const [pq, mq] = hasSlash ? q.split("/", 2).map((s) => s.trim()) : [null, null];

  return groups
    .map((g) => {
      if (pq != null) {
        const providerHit = !pq || tokenMatches(g.label, pq);
        if (!providerHit) return { ...g, items: [] };
        const items = g.items.filter((i) => !mq || tokenMatches(i.label, mq));
        return { ...g, items };
      }
      const items = g.items.filter(
        (i) =>
          tokenMatches(i.label, q) ||
          tokenMatches(g.label, q) ||
          tokenMatches(`${g.label}/${i.label}`, q),
      );
      return { ...g, items };
    })
    .filter((g) => g.items.length > 0);
}
