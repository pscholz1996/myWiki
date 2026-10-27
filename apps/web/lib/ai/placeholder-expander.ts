/**
 * Swaps `{{visual:ID}}` placeholders in a text stream for the visuals they
 * stand for.
 *
 * The institute model doesn't copy a finished visual into its answer — a
 * long Mermaid block or an image url retyped by a language model is a fine
 * place for a typo. It writes a short placeholder where the visual belongs,
 * and this swaps it in as the text streams past.
 *
 * Streaming is what makes this a state machine rather than a replace(): a
 * placeholder can arrive split across deltas ("{{vis" … "ual:v1}}"), so the
 * tail that might be the start of one is held back until it either closes
 * or clearly isn't one.
 */

const PLACEHOLDER = /^\{\{\s*visual\s*:\s*([A-Za-z0-9_-]+)\s*\}\}$/;

// Longest text held back while waiting for a "}}". A real placeholder is
// ~15 characters; anything far longer is ordinary text that happens to
// contain "{{" (LaTeX, templating examples) and must flow on.
const MAX_PENDING = 64;

export function createPlaceholderExpander(
  resolve: (id: string) => string | undefined,
) {
  let pending = "";
  const used = new Set<string>();

  const expand = (token: string): string => {
    const match = token.match(PLACEHOLDER);
    if (!match) return token;
    const markdown = resolve(match[1]);
    // Only reached at the end of the stream (drain holds unresolved ones
    // until then): a placeholder whose visual never came — the specialist
    // declined, or the id was made up — means nothing to a reader.
    if (markdown === undefined) return "";
    used.add(match[1]);
    // Block-level content: its own paragraph, or markdown would glue an
    // image or a code fence onto the sentence before it.
    return `\n\n${markdown}\n\n`;
  };

  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      const open = pending.indexOf("{{");
      if (open < 0) {
        // A lone trailing "{" may be half of the next "{{".
        if (!final && pending.endsWith("{")) {
          out += pending.slice(0, -1);
          pending = "{";
        } else {
          out += pending;
          pending = "";
        }
        return out;
      }
      out += pending.slice(0, open);
      pending = pending.slice(open);
      const close = pending.indexOf("}}");
      if (close >= 0) {
        const token = pending.slice(0, close + 2);
        const match = token.match(PLACEHOLDER);
        if (match && !final && resolve(match[1]) === undefined) {
          // Written before the visual exists. Seen live: the model drafts
          // the whole answer, placeholder included, in the same reply that
          // asks for the visual — it guesses the id. Hold the text from
          // here until the tool has run (retry), rather than letting the
          // raw token through and the visual end up after the answer.
          return out;
        }
        out += expand(token);
        pending = pending.slice(close + 2);
        continue;
      }
      if (final || pending.length > MAX_PENDING) {
        // Not going to close (or the stream ended): plain text after all.
        out += pending.slice(0, 2);
        pending = pending.slice(2);
        continue;
      }
      return out;
    }
  };

  return {
    /** Feeds a delta; returns the text that is safe to show now. */
    push(text: string): string {
      pending += text;
      return drain(false);
    },
    /** After a round of tool calls: releases text held for a visual that now exists. */
    retry(): string {
      return drain(false);
    },
    /** Ends the stream; returns whatever was still held back. */
    flush(): string {
      return drain(true);
    },
    /** Ids whose placeholder appeared in the text. */
    used(): ReadonlySet<string> {
      return used;
    },
  };
}
