// Repetition detection and repair.
// Ports behavior from litellm_logic/nim/repair/repetition.py.

export function repairRepetition(text: string): string | null {
  const lines = text.split("\n");
  if (lines.length < 3) return null;

  // Remove consecutively repeated lines (keep original + 1 duplicate max)
  const deduplicated: string[] = [];
  let lastAdded: string | null = null;
  let consecutiveCount = 0;

  for (const line of lines) {
    const normalized = line.trim().toLowerCase();
    if (lastAdded !== null && normalized === lastAdded) {
      consecutiveCount++;
      if (consecutiveCount <= 1) {
        deduplicated.push(line);
      }
      // Skip if same line repeated more than twice consecutively
    } else {
      consecutiveCount = 0;
      deduplicated.push(line);
      lastAdded = normalized;
    }
  }

  const result = deduplicated.join("\n");
  return result !== text ? result : null;
}
