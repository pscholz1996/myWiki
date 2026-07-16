import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKControlGetUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getAiSourceRecord,
  listAiSources,
  normalizeWhitespace,
  readAiSourceFull,
  readAiSourcePage,
  saveResearchNote,
  searchAiKnowledgeBase,
  updateAiSourceMetadata,
  verifyAiCitation,
} from "@/lib/ai/knowledge-base";
import {
  annotateRegisteredImage,
  cropRegisteredImage,
  extractPptxMediaImage,
  getImageRecord,
  imageUrl,
  listPptxMedia,
  readImagePng,
  renderPdfPage,
  type AiAnnotation,
  type AiImageRecord,
} from "@/lib/ai/images";
import type { AiChatRequest, AiConversation } from "@/lib/ai/types";

function callResult(text: unknown, isError = false): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof text === "string"
            ? text
            : `${JSON.stringify(text, null, 2)}\n`,
      },
    ],
    isError,
  } as CallToolResult;
}

/**
 * Sources cited earlier in this conversation that no longer exist in the
 * current knowledge base (e.g. the user deleted them because they turned
 * out to be wrong or irrelevant). A prior verified cite() does not remain
 * valid after deletion — the model must be told explicitly, by name, or it
 * will restate the fact from its own conversational memory of the earlier
 * tool result without re-verifying (confirmed by testing: it will even
 * claim "(verified)" in prose despite calling no tool this turn).
 */
export function findStaleCitedSourceIds(
  conversation: AiConversation,
  currentSourceIds: Set<string>,
): string[] {
  const citedSourceIds = new Set<string>();
  for (const message of conversation.messages) {
    for (const citation of message.citations ?? []) {
      citedSourceIds.add(citation.sourceId);
    }
  }
  return [...citedSourceIds].filter((id) => !currentSourceIds.has(id));
}

async function serializePrompt(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
): Promise<string> {
  const manifest = await listAiSources(projectDir);
  const currentSourceIds = new Set(manifest.sources.map((source) => source.id));
  const staleSourceIds = findStaleCitedSourceIds(
    conversation,
    currentSourceIds,
  );

  const lines = [
    "You are myWiki — a personal knowledge assistant answering questions from the user's own library (systems engineering, AI research, standards/norms, books, papers, slides) plus your general knowledge.",
    "Follow these rules:",
    "",
    "## Answering",
    "- Your job is knowledge, not writing: give the clearest, most correct answer to the question. You have no file-editing tools and never draft documents.",
    "- Answer in the language of the question: a German question gets a German answer, an English question an English one. Keep source terminology as-is (e.g. a norm's defined German/English terms) where translating would change meaning.",
    '- Everything you write outside tool calls is shown to the user as one continuous answer — so never narrate your process ("searching now…", "found it, looks good, next I\'ll…"). Work silently between tool calls and write only the polished answer itself.',
    "- Ground answers in the knowledge base first. For a substantive question, don't stop at the first useful chunk: search from multiple angles/phrasings — different terms, synonyms, related sub-questions, German and English where relevant — then synthesize one holistic answer across every relevant source.",
    '- Where the sources don\'t cover something (or the question goes beyond them), answer from your general knowledge — but make the boundary visible. Mark those parts briefly, e.g. a short parenthetical "(general knowledge — not in your sources)" or a one-line note; never blur what came from the library vs. from you.',
    "- If neither the sources nor your general knowledge support a confident answer, say so plainly.",
    "",
    "## Visual answers",
    "- Choose the form that communicates best; plain text is the default, not the ceiling.",
    "- Use a GFM markdown table for comparisons, trade-offs, parameter lists, requirement matrices, or anything naturally tabular.",
    "- Use LaTeX math ($inline$ or $$display$$) for every equation or formal definition — never ASCII-art math.",
    "- Use a ```mermaid fenced code block for structures and behavior: processes (flowchart TD/LR), sequences (sequenceDiagram), states (stateDiagram-v2), class/block structures (classDiagram), timelines, mindmaps. Systems-engineering questions (V-model, requirement flows, architectures, interfaces) very often deserve a diagram — reach for one whenever a picture beats a paragraph.",
    "- Combine forms freely: a short prose explanation plus a diagram or table usually beats either alone. Don't force a visual when text answers cleanly.",
    "",
    "## Source images (original figures from the library)",
    "- When a source contains the actual figure for what's being asked (the V-model diagram in a handbook, an architecture figure in a paper, a chart on a slide), showing THAT original beats redrawing it. Workflow: find the page/slide via search or read_source_page, then for PDFs call view_page_image and crop_image to cut out just the figure; for pptx sources call list_slide_images + view_image. Embed the result with markdown: ![short description](its url).",
    "- Embed ONLY the figure, never the whole page: a full page render has no embeddable url (it is your working material for locating the figure) — always crop_image the exact figure region first, check the crop looks clean, and embed that. If the crop caught page furniture (headers, body text, neighboring figures), redo it tighter.",
    '- Do this proactively, not only when asked for an image: whenever your search results suggest a source has a figure that would genuinely help the explanation (search hits mentioning "Figure/Abbildung/Bild/Diagramm/Tabelle X", figure captions, slides that are clearly diagram slides), consider pulling it in on your own initiative. A question about a concept that a source illustrates deserves the source\'s illustration. Skip it when a figure adds nothing — proactive, not decorative.',
    "- Every image you embed MUST be followed on the next line by an italic attribution, e.g. *Source: INCOSE Handbook, p. 34* — the tool result gives you the exact attribution string to use. Never show a source image without saying where it's from.",
    '- You may annotate a source image when a mark genuinely helps the explanation (circle the relevant block, arrow to the step being discussed, highlight a region) via annotate_image. Annotations are strictly additive pointers: never cover, redact, or alter the figure\'s own content, labels, or terminology, never more marks than the point needs, and the attribution already says "(annotated)" — keep it. Prefer shapes over text labels; a label is for short pointers only ("here", "Step 2").',
    "- Look at what each image tool returns (you see the image) and check it before embedding: is the crop clean, is the annotation on the right spot? Redo it if not — never embed an image you haven't visually checked.",
    "- If no source contains a suitable figure, say so if the user asked for one, and fall back to a mermaid diagram (marked as your own rendering, not from a source).",
    "",
    "## Sources & attribution",
    "- Attribution is lightweight but honest: the user must always see where knowledge came from and be able to jump into the source — not bibliography-grade referencing.",
    '- Inline source labels: whenever a claim, number, or finding comes from a specific source, follow it with an inline markdown link of the form [ShortName Year, S. N](/api/ai/sources/SOURCE_ID/file#page=N) — e.g. [Poulsen 2025, S. 5](/api/ai/sources/abc-123/file#page=5). The UI renders these as clickable source labels that open the PDF at that page. Use them instead of plain-text parentheses like "(Poulsen et al. 2025)": every source mention should be such a link. Keep the label short (first author + year, or a short title, plus page/slide). Use each source\'s real id from search results/browse.',
    "- For pivotal or surprising source-backed claims, verify the exact quote with cite() so the answer carries a verified source chip the user can open. Routine background claims don't each need their own cite() call.",
    "- If a quote cannot be verified, say so and keep searching instead of guessing.",
    "- A citation made earlier in THIS conversation is not automatically still valid (sources can be deleted mid-conversation) — re-verify with cite() before restating it as verified. Re-verification is something you silently DO, never something you narrate.",
    '- Search results and browse_knowledge_base may include research notes you saved in earlier turns (kind "note") alongside primary sources. A note is your own prior synthesis — useful context, never a primary source; cite() refuses to verify against it. When a broad multi-source search produces a genuinely new synthesis worth keeping, save it with save_research_note so future turns don\'t redo the work.',
    "- If a source's stored title/authors looks wrong against the page text, point it out and ask before changing anything; only call update_source_metadata after the user explicitly confirms the correction.",
    staleSourceIds.length > 0
      ? `- The following source IDs were cited earlier in this conversation but have since been permanently REMOVED from the knowledge base: ${staleSourceIds.join(", ")}. Do not restate, confirm, or rely on anything from them. If asked, say the source was removed from the knowledge base and that information can no longer be verified.`
      : null,
    request.sourceIds && request.sourceIds.length > 0
      ? `Selected sources: ${request.sourceIds.join(", ")}`
      : "Selected sources: all available sources",
    "",
    "User request:",
    request.message,
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function normalizeToolResult(value: unknown): CallToolResult {
  return callResult(value);
}

export function createMyWikiMcpServer(
  projectDir: string,
  scopedSourceIds?: string[],
) {
  return createSdkMcpServer({
    name: "mywiki",
    version: "0.1.0",
    alwaysLoad: true,
    tools: [
      tool(
        "search_knowledge_base",
        "Search indexed project knowledge sources (and your own earlier research notes) for relevant chunks, ranked by combined semantic + keyword match. For a substantive question, one call is rarely enough — issue several searches with different phrasings/angles/terms to pull in everything relevant across ALL sources before you answer, the way a thorough literature review would, not just whichever source the first query happened to hit.",
        {
          query: z.string(),
          topK: z.number().int().min(1).max(10).optional(),
        },
        async (args) => {
          // scopedSourceIds is ambient (set by the conversation's selected
          // sources, not by the model) — a hard restriction the model
          // cannot widen by omitting it from the call.
          const hits = await searchAiKnowledgeBase(
            projectDir,
            args.query,
            args.topK ?? 5,
            scopedSourceIds,
          );
          return normalizeToolResult({ hits });
        },
      ),
      tool(
        "browse_knowledge_base",
        "List sources and research notes as a table of contents: title, kind, authors, year, plus a per-source digest (abstract snippet and section outline with page numbers). Use this to PLAN retrieval — the outline tells you which source and page range covers a topic, often better than a blind search. Pass detail: 'full' for complete abstracts and outlines, source_id to inspect a single source's digest in depth.",
        {
          kind: z.enum(["pdf", "pptx", "markdown", "text", "note"]).optional(),
          source_id: z.string().optional(),
          detail: z.enum(["compact", "full"]).optional(),
        },
        async (args) => {
          try {
            const manifest = await listAiSources(projectDir);
            const scoped =
              scopedSourceIds && scopedSourceIds.length > 0
                ? new Set(scopedSourceIds)
                : null;
            const full = args.detail === "full" || Boolean(args.source_id);
            const entries = manifest.sources
              .filter((source) => !scoped || scoped.has(source.id))
              .filter((source) => !args.kind || source.kind === args.kind)
              .filter(
                (source) => !args.source_id || source.id === args.source_id,
              )
              .map((source) => ({
                id: source.id,
                kind: source.kind,
                title:
                  source.kind === "note"
                    ? source.originalName
                    : (source.metadata?.title ?? source.originalName),
                authors: source.metadata?.authors,
                year: source.metadata?.year,
                pageCount: source.pageCount,
                bibKey: source.bibKey,
                abstract: full
                  ? source.digest?.abstract
                  : source.digest?.abstract?.slice(0, 180),
                outline: full
                  ? source.digest?.outline
                  : source.digest?.outline
                      ?.slice(0, 8)
                      .map((entry) => entry.heading),
              }));
            return normalizeToolResult({ sources: entries });
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to browse knowledge base",
              true,
            );
          }
        },
      ),
      tool(
        "read_source_page",
        "Read the verified text from a specific source page.",
        {
          sourceId: z.string(),
          page: z.number().int().min(1),
        },
        async (args) => {
          try {
            const result = await readAiSourcePage(
              projectDir,
              args.sourceId,
              args.page,
            );
            return normalizeToolResult(result);
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to read source page",
              true,
            );
          }
        },
      ),
      tool(
        "read_source_full",
        "Read the full extracted text for a source.",
        {
          sourceId: z.string(),
        },
        async (args) => {
          try {
            const result = await readAiSourceFull(projectDir, args.sourceId);
            return normalizeToolResult(result);
          } catch (error) {
            return callResult(
              error instanceof Error ? error.message : "Failed to read source",
              true,
            );
          }
        },
      ),
      tool(
        "cite",
        "Verify that an exact quote appears on the requested source page. A successful cite() attaches a verified, clickable source chip (source + page) to your answer — use it for the pivotal claims an answer rests on.",
        {
          sourceId: z.string(),
          page: z.number().int().min(1),
          quote: z.string(),
        },
        async (args) => {
          try {
            const result = await verifyAiCitation({
              projectDir,
              sourceId: args.sourceId,
              page: args.page,
              quote: args.quote,
            });
            return normalizeToolResult(result);
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Citation verification failed",
              true,
            );
          }
        },
      ),
      tool(
        "update_source_metadata",
        'Correct a knowledge-base source\'s own stored title/authors/year (what browse_knowledge_base and the source list show). Only call this once the user has explicitly confirmed the correction in this conversation (e.g. "yes, fix it, the real title is X"); noticing a likely mismatch yourself is a reason to point it out and ask, never to silently overwrite. Pass the full corrected title, authors, and year together, even for a field that isn\'t changing — this replaces all three at once rather than patching one field, and sets the source\'s provenance to "manual", the same trust tier as a human editing it directly.',
        {
          source_id: z.string(),
          title: z.string().min(1),
          authors: z.array(z.string()),
          year: z.string(),
        },
        async (args) => {
          try {
            const source = await getAiSourceRecord(projectDir, args.source_id);
            if (!source) {
              return callResult({ error: "Source not found" }, true);
            }
            if (source.kind === "note") {
              return callResult(
                {
                  error: `"${source.originalName}" is an AI-authored research note, not a primary source — it has no bibliographic metadata to correct.`,
                },
                true,
              );
            }

            const updated = await updateAiSourceMetadata(
              projectDir,
              args.source_id,
              {
                title: args.title,
                authors: args.authors,
                year: args.year,
              },
            );

            // Best-effort sanity check, not a
            // hard gate, since the whole point here is that some other
            // system (CrossRef, the PDF's own embedded metadata) got it
            // wrong and page 1 is the actual ground truth.
            let titleVerified: boolean | null = null;
            try {
              const { text } = await readAiSourcePage(
                projectDir,
                args.source_id,
                1,
              );
              titleVerified = normalizeWhitespace(text)
                .toLowerCase()
                .includes(normalizeWhitespace(args.title).toLowerCase());
            } catch {
              titleVerified = null;
            }

            return normalizeToolResult({
              id: updated.id,
              title: updated.metadata?.title,
              authors: updated.metadata?.authors,
              year: updated.metadata?.year,
              provenance: updated.metadata?.provenance,
              titleVerified,
            });
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to update source metadata",
              true,
            );
          }
        },
      ),
      tool(
        "save_research_note",
        "Save your own synthesized understanding into the knowledge base so you (and future turns) can find and build on it via search_knowledge_base/browse_knowledge_base. This is YOUR analysis, not a primary source — it can never be a cite() target; every source-backed claim still needs its own fresh cite() against the primary source. Pass note_id to update a note you already saved (when you have a meaningfully new synthesis) instead of creating a near-duplicate.",
        {
          title: z.string().min(1),
          content: z.string().min(1),
          source_ids: z
            .array(z.string())
            .optional()
            .describe(
              "IDs of primary sources this note draws on, for traceability only — never usable to satisfy cite().",
            ),
          note_id: z
            .string()
            .optional()
            .describe("ID of a note you saved earlier, to update it in place."),
        },
        async (args) => {
          try {
            const record = await saveResearchNote({
              projectDir,
              title: args.title,
              content: args.content,
              drawsOnSourceIds: args.source_ids,
              noteId: args.note_id,
            });
            return normalizeToolResult({
              id: record.id,
              title: record.originalName,
              updated: Boolean(args.note_id),
            });
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to save research note",
              true,
            );
          }
        },
      ),
      tool(
        "view_page_image",
        "Render a PDF source page as an image and look at it. Use this to find and visually locate a figure/diagram/table on a page before cropping it out with crop_image. Returns the rendered image (so you can see it) plus its id, url, and the attribution string to place under any embed.",
        {
          source_id: z.string(),
          page: z.number().int().min(1),
        },
        async (args) => {
          try {
            const record = await renderPdfPage(
              projectDir,
              args.source_id,
              args.page,
            );
            return await imageToolResult(projectDir, record);
          } catch (error) {
            return callResult(
              error instanceof Error ? error.message : "Failed to render page",
              true,
            );
          }
        },
      ),
      tool(
        "list_slide_images",
        "List the images embedded in a PowerPoint (.pptx) source, with the slide each one belongs to. Follow up with view_image on a media entry to actually see it.",
        {
          source_id: z.string(),
          slide: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Only list images on this slide."),
        },
        async (args) => {
          try {
            const media = await listPptxMedia(projectDir, args.source_id);
            const filtered = args.slide
              ? media.filter((entry) => entry.slide === args.slide)
              : media;
            return normalizeToolResult({
              images: filtered,
              hint: "Call view_image with source_id + slide + media_name to see one.",
            });
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to list slide images",
              true,
            );
          }
        },
      ),
      tool(
        "view_image",
        "Look at an image: either a registered image by image_id (e.g. to re-check a crop), or a pptx media image by source_id + slide + media_name (from list_slide_images), which registers it and returns its id/url.",
        {
          image_id: z.string().optional(),
          source_id: z.string().optional(),
          slide: z.number().int().min(1).optional(),
          media_name: z.string().optional(),
        },
        async (args) => {
          try {
            if (args.image_id) {
              const record = await getImageRecord(projectDir, args.image_id);
              if (!record)
                return callResult({ error: "Image not found" }, true);
              return await imageToolResult(projectDir, record);
            }
            if (args.source_id && args.slide && args.media_name) {
              const record = await extractPptxMediaImage(
                projectDir,
                args.source_id,
                args.slide,
                args.media_name,
              );
              return await imageToolResult(projectDir, record);
            }
            return callResult(
              { error: "Pass image_id, or source_id + slide + media_name" },
              true,
            );
          } catch (error) {
            return callResult(
              error instanceof Error ? error.message : "Failed to view image",
              true,
            );
          }
        },
      ),
      tool(
        "crop_image",
        "Cut a region (the figure you want to show) out of a registered image — typically a page render from view_page_image. Coordinates are normalized 0-1 relative to that image: x,y is the top-left corner of the crop box. Returns the cropped image so you can check it's clean before embedding its url.",
        {
          image_id: z.string(),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().min(0.01).max(1),
          height: z.number().min(0.01).max(1),
        },
        async (args) => {
          try {
            const record = await cropRegisteredImage(
              projectDir,
              args.image_id,
              {
                x: args.x,
                y: args.y,
                width: args.width,
                height: args.height,
              },
            );
            return await imageToolResult(projectDir, record);
          } catch (error) {
            return callResult(
              error instanceof Error ? error.message : "Failed to crop image",
              true,
            );
          }
        },
      ),
      tool(
        "annotate_image",
        'Draw explanation marks on top of a registered image: circle, rect, arrow, highlight, or a short label. Strictly additive pointers — never cover or alter the figure\'s own content or terminology. Coordinates are normalized 0-1 (circle radius relative to image width). Produces a NEW image whose attribution ends in "(annotated)"; the original stays untouched. Returns the annotated image so you can check mark placement before embedding.',
        {
          image_id: z.string(),
          annotations: z
            .array(
              z.object({
                type: z.enum(["circle", "rect", "highlight", "arrow", "label"]),
                x: z.number().min(0).max(1).optional(),
                y: z.number().min(0).max(1).optional(),
                width: z.number().min(0).max(1).optional(),
                height: z.number().min(0).max(1).optional(),
                radius: z.number().min(0.005).max(0.5).optional(),
                fromX: z.number().min(0).max(1).optional(),
                fromY: z.number().min(0).max(1).optional(),
                toX: z.number().min(0).max(1).optional(),
                toY: z.number().min(0).max(1).optional(),
                text: z.string().max(40).optional(),
                color: z.enum(["red", "blue", "green", "orange"]).optional(),
              }),
            )
            .min(1)
            .max(12),
        },
        async (args) => {
          try {
            const record = await annotateRegisteredImage(
              projectDir,
              args.image_id,
              args.annotations as AiAnnotation[],
            );
            return await imageToolResult(projectDir, record);
          } catch (error) {
            return callResult(
              error instanceof Error
                ? error.message
                : "Failed to annotate image",
              true,
            );
          }
        },
      ),
    ],
  });
}

/**
 * Tool result carrying the actual image (so the model can look at what it
 * just rendered/cropped/annotated) plus the machine-readable bits it needs
 * to embed it: the markdown url and the mandatory attribution line.
 */
async function imageToolResult(
  projectDir: string,
  record: AiImageRecord,
): Promise<CallToolResult> {
  const png = await readImagePng(projectDir, record.id);
  if (!png) return callResult({ error: "Image file missing" }, true);

  // Full page renders are working material, not deliverables — embedding a
  // whole page where a single figure was meant looks broken to the user
  // (seen live). Withholding the URL makes the crop step structurally
  // unskippable instead of relying on the model remembering a rule.
  const embeddable = record.kind !== "page-render";
  const payload = embeddable
    ? {
        imageId: record.id,
        url: imageUrl(record),
        width: record.width,
        height: record.height,
        kind: record.kind,
        attribution: record.attribution,
        embedAs: `![<short description>](${imageUrl(record)})\n*Source: ${record.attribution}*`,
      }
    : {
        imageId: record.id,
        width: record.width,
        height: record.height,
        kind: record.kind,
        attribution: record.attribution,
        note: "Full page render — for locating the figure only, it cannot be embedded. Cut the figure out with crop_image (normalized bbox); the crop result is embeddable.",
      };

  return {
    content: [
      {
        type: "image",
        data: png.toString("base64"),
        mimeType: "image/png",
      },
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  } as CallToolResult;
}

// A pushable async-iterable "inbox": the persistent Query's prompt keeps
// consuming from this across many turns, not just one — that's what keeps
// the underlying Claude Agent SDK session (and its CLI subprocess) alive
// between separate chat HTTP requests instead of spawning a fresh one per
// message. Needed for anything that requires "streaming input mode" (the
// experimental usage/rate-limit query below); a plain string prompt only
// ever supports a single one-shot turn per process.
class PushableQueue<T> implements AsyncIterable<T> {
  private buffered: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.buffered.push(value);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined as never, done: true });
    }
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({
            value: this.buffered.shift() as T,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

// Buffers one chat turn's worth of messages so a caller can consume them
// as an AsyncGenerator (matching the shape callers already expect) even
// though they're really being dispatched from one long-lived background
// pump shared across every turn — see LiveSession.pump().
class TurnMessageStream {
  private buffered: SDKMessage[] = [];
  private waiter: ((result: IteratorResult<SDKMessage>) => void) | null = null;
  private finished = false;

  push(message: SDKMessage): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: message, done: false });
    } else {
      this.buffered.push(message);
    }
  }

  finish(): void {
    this.finished = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (true) {
      if (this.buffered.length > 0) {
        yield this.buffered.shift() as SDKMessage;
        continue;
      }
      if (this.finished) return;
      const result = await new Promise<IteratorResult<SDKMessage>>(
        (resolve) => {
          this.waiter = resolve;
        },
      );
      if (result.done) return;
      yield result.value;
    }
  }
}

// One persistent Query per project, reused across every chat turn instead
// of spawning a fresh CLI subprocess per message. A single background pump
// (see .pump()) continuously reads the Query's own message stream and
// hands each message to whichever turn is currently in flight; .busy
// guards against a second turn starting before the first resolves (this
// app is single-user/single-conversation-per-project, so turns are never
// meant to overlap — a second one arriving mid-turn is a bug upstream, not
// something to silently queue).
class LiveSession {
  private inbox = new PushableQueue<SDKUserMessage>();
  private query: Query;
  private currentTurn: TurnMessageStream | null = null;

  constructor(options: {
    cwd: string;
    sourceIds: string[];
    model: string;
    isNewSession: boolean;
    sdkSessionId: string;
  }) {
    // `sessionId` creates a session under a caller-chosen id and is only
    // valid on the first turn; resuming an existing session must use
    // `resume` instead (the SDK does not treat repeating `sessionId` as a
    // resume — it conflicts with the already-persisted session and
    // crashes the CLI process).
    const sessionOptions = options.isNewSession
      ? { sessionId: options.sdkSessionId }
      : { resume: options.sdkSessionId };

    this.query = query({
      prompt: this.inbox,
      options: {
        cwd: options.cwd,
        ...sessionOptions,
        persistSession: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: [],
        mcpServers: {
          mywiki: createMyWikiMcpServer(options.cwd, options.sourceIds),
        },
        includePartialMessages: true,
        // Generous on purpose: a single grounded answer legitimately chains
        // many tool calls (multi-angle searches, browse, several page
        // reads, render/crop/annotate figures, cite()) — a tight cap makes
        // exactly the thorough answers this app exists for "stop early"
        // (seen live at 8). This is a runaway-loop backstop, not a budget;
        // the real spend control is the user's plan limit.
        maxTurns: 100,
        model: options.model,
        // Long research conversations can exceed the context window. The
        // SDK (the same engine behind Claude Code) already knows how to
        // compact — summarize older turns and keep going — but that
        // behavior lives behind a settings flag rather than being
        // unconditionally on, so set it explicitly instead of relying on
        // an ambient default we don't control from here.
        settings: { autoCompactEnabled: true },
      },
    });

    void this.pump();
  }

  private async pump(): Promise<void> {
    for await (const message of this.query) {
      this.currentTurn?.push(message);
      if (message.type === "result") {
        this.currentTurn?.finish();
        this.currentTurn = null;
      }
    }
  }

  get busy(): boolean {
    return this.currentTurn !== null;
  }

  // Re-scopes the session's knowledge-base tools to the currently-checked
  // sources before each turn — with a fresh query() per turn (the old
  // design) this happened implicitly every time; a persistent session
  // needs the explicit dynamic-reconfigure call so changing which sources
  // are checked still takes effect on the very next message.
  async rescopeSources(cwd: string, sourceIds: string[]): Promise<void> {
    await this.query.setMcpServers({
      mywiki: createMyWikiMcpServer(cwd, sourceIds),
    });
  }

  async *runTurn(userMessage: SDKUserMessage): AsyncGenerator<SDKMessage> {
    if (this.currentTurn) {
      throw new Error(
        "A message is already being processed for this conversation.",
      );
    }
    const stream = new TurnMessageStream();
    this.currentTurn = stream;
    this.inbox.push(userMessage);
    yield* stream;
  }

  async usage(): Promise<SDKControlGetUsageResponse> {
    return this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  close(): void {
    this.inbox.close();
    this.query.close();
  }
}

// Keyed on globalThis (not a plain module-level Map) so Next.js dev-mode
// hot-reloading of this module doesn't orphan a live session's underlying
// CLI subprocess — reloading would otherwise silently drop the only
// reference to it without ever calling .close().
const globalForSessions = globalThis as unknown as {
  __mywikiLiveSessions?: Map<string, LiveSession>;
};
const liveSessions =
  globalForSessions.__mywikiLiveSessions ?? new Map<string, LiveSession>();
globalForSessions.__mywikiLiveSessions = liveSessions;

function sessionKey(projectDir: string, conversationId: string): string {
  return `${projectDir}::${conversationId}`;
}

/**
 * Close the live SDK session for one conversation, or (with no
 * conversationId) every session under the project — the latter is what
 * switching the knowledge folder needs.
 */
export function closeLiveSession(
  projectDir: string,
  conversationId?: string,
): void {
  const prefix = `${projectDir}::`;
  for (const [key, session] of liveSessions) {
    if (
      conversationId
        ? key === sessionKey(projectDir, conversationId)
        : key.startsWith(prefix)
    ) {
      session.close();
      liveSessions.delete(key);
    }
  }
}

export async function getPlanUsage(
  projectDir: string,
): Promise<SDKControlGetUsageResponse | null> {
  // Any live session under this project can answer the plan-usage query —
  // usage is account-level, not conversation-level.
  const prefix = `${projectDir}::`;
  const session = [...liveSessions.entries()].find(([key]) =>
    key.startsWith(prefix),
  )?.[1];
  if (!session) return null;
  try {
    return await session.usage();
  } catch {
    // The experimental control API can fail transiently (e.g. right after
    // a turn finishes, before the transport settles) — treat that the same
    // as "not available yet" rather than surfacing an error for what's
    // meant to be a best-effort display.
    return null;
  }
}

export async function* runMyWikiChatTurn(
  projectDir: string,
  conversation: AiConversation,
  request: AiChatRequest,
  isNewSession: boolean,
) {
  const prompt = await serializePrompt(projectDir, conversation, request);
  const sdkSessionId = conversation.sdkSessionId ?? conversation.id;
  const model = request.model ?? conversation.model ?? "claude-sonnet-5";

  const key = sessionKey(projectDir, conversation.id);
  let session = liveSessions.get(key);
  if (!session) {
    // One CLI subprocess per live conversation would accumulate as the
    // user switches around their history — close the project's other
    // sessions first. Switching back re-resumes from sdkSessionId, so
    // nothing is lost except a warm process.
    closeLiveSession(projectDir);
    session = new LiveSession({
      cwd: projectDir,
      sourceIds: conversation.sourceIds,
      model,
      isNewSession,
      sdkSessionId,
    });
    liveSessions.set(key, session);
  } else {
    await session.rescopeSources(projectDir, conversation.sourceIds);
  }

  const userMessage: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  };

  yield* session.runTurn(userMessage);
}
