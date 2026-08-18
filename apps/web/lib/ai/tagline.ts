import { query } from "@anthropic-ai/claude-agent-sdk";
import { listAiSources } from "@/lib/ai/knowledge-base";
import type { AiSourceRecord } from "@/lib/ai/types";
import { sanitizeTaglineTail } from "@/lib/ai/types";

/**
 * Cheapest model on the list. This is a one-line cosmetic string; spending a
 * Sonnet turn on it every time the library changes would be absurd.
 */
const TAGLINE_MODEL = "haiku";

/** Enough titles to see what a library is about without paying for the tail. */
const MAX_TITLES = 24;

/**
 * Keyed on the source set, not the project: the clause is only ever wrong
 * because the library changed, and re-deriving it on every mount of the empty
 * state would bill a turn for a subtitle. In memory rather than on disk on
 * purpose — a server restart regenerating it once is cheaper than owning a
 * cache file that can go stale against the manifest.
 */
const globalForTagline = globalThis as unknown as {
  __mywikiTagline?: Map<string, Promise<string | null>>;
};
const cache = (globalForTagline.__mywikiTagline ??= new Map());

/** What the model is shown of a source — its real title, else the filename. */
function sourceLabel(source: AiSourceRecord): string {
  return source.metadata?.title?.trim() || source.originalName;
}

function cacheKey(sources: AiSourceRecord[]): string {
  return sources
    .map((source) => source.id)
    .sort()
    .join("|");
}

function buildPrompt(labels: string[]): string {
  return [
    "You are writing one closing clause for a subtitle in myWiki, a research app.",
    "",
    'The finished sentence reads: "Answers drawn from your N sources — YOUR CLAUSE"',
    "",
    "These are the sources in this particular library:",
    ...labels.map((label) => `- ${label}`),
    "",
    "Write the clause so it names what THIS library is actually about, in the",
    "register of these examples:",
    "  let's work through your systems engineering material.",
    "  let's dig into your AI project in vessel technology.",
    "",
    "Rules:",
    `- one clause, at most 70 characters`,
    "- start lowercase, end with a full stop",
    "- plain text only: no quotation marks, no markdown, no emoji",
    "- name the real subject matter of these sources; never invent a topic",
    "  that isn't in the list",
    "- if the sources are genuinely unrelated, describe their breadth instead",
    "  of pretending they share a theme",
    "",
    "Reply with the clause and nothing else.",
  ].join("\n");
}

async function generate(
  projectDir: string,
  labels: string[],
): Promise<string | null> {
  // `persistSession: false` keeps this throwaway turn out of the user's
  // ~/.claude history, and `tools: []` denies it the knowledge base: it gets
  // the titles in the prompt and nothing else, so it can't wander into
  // reading sources and turn a subtitle into a billed research session.
  const probe = query({
    prompt: buildPrompt(labels),
    options: {
      cwd: projectDir,
      model: TAGLINE_MODEL,
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
      tools: [],
    },
  });

  try {
    for await (const message of probe) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success") return null;
      return sanitizeTaglineTail(message.result);
    }
    return null;
  } finally {
    probe.close();
  }
}

/**
 * A project-specific closing clause for the empty state's subtitle, or null
 * to leave the default in place.
 *
 * Null is a normal outcome, not an error: an empty library has nothing to
 * describe, and a failed or malformed generation is not worth surfacing for a
 * decorative line. Every caller falls back to DEFAULT_TAGLINE_TAIL.
 */
export async function getProjectTagline(
  projectDir: string,
): Promise<string | null> {
  const manifest = await listAiSources(projectDir);
  const sources = manifest.sources;
  if (sources.length === 0) return null;

  const key = cacheKey(sources);
  const cached = cache.get(key);
  if (cached) return cached;

  const labels = sources.slice(0, MAX_TITLES).map(sourceLabel);
  const pending = generate(projectDir, labels);
  cache.set(key, pending);
  // Only a usable clause is worth keeping. A failure here is usually "not
  // logged in yet" or a hiccup, which the next visit may well not have.
  pending
    .then((tail) => {
      if (!tail) cache.delete(key);
    })
    .catch(() => cache.delete(key));

  return pending;
}
