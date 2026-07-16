/**
 * Joins consecutive assistant text parts of one agentic turn. Each loop
 * iteration (text → tool calls → more text) arrives as its own assistant
 * message; gluing them together without a boundary breaks markdown — a
 * part starting with "## Heading" fused onto the previous sentence renders
 * a literal "##" (seen live). A blank line between parts keeps every
 * block construct (headings, lists, fences, tables) valid.
 *
 * Returns what should be appended/streamed for this part — the caller
 * concatenates it onto the accumulated text verbatim.
 */
export function joinAssistantPart(accumulated: string, part: string): string {
  if (!part) return "";
  const needsSeparator =
    accumulated.length > 0 &&
    !accumulated.endsWith("\n") &&
    !part.startsWith("\n");
  return needsSeparator ? `\n\n${part}` : part;
}
