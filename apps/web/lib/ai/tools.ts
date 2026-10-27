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

/**
 * The knowledge-base tools, defined once and independent of which model
 * calls them.
 *
 * They used to live inline in the Claude Agent SDK's MCP server, where the
 * handlers could only be reached through the SDK's tool() wrapper. Pulled
 * out here, a caller wraps them in whatever envelope it needs — agent.ts as
 * SDK tools — and no second agent ever needs its own copy of, say, the
 * citation verifier, the one place where drift is least acceptable.
 */
export interface MyWikiTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** Receives arguments already validated against `shape`. */
  run: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
): MyWikiTool {
  return {
    name,
    description,
    shape,
    run: run as MyWikiTool["run"],
  };
}

export function callResult(text: unknown, isError = false): CallToolResult {
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

function normalizeToolResult(value: unknown): CallToolResult {
  return callResult(value);
}

export function createMyWikiTools(
  projectDir: string,
  scopedSourceIds?: string[],
): MyWikiTool[] {
  return [
    defineTool(
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
    defineTool(
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
            .filter((source) => !args.source_id || source.id === args.source_id)
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
    defineTool(
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
    defineTool(
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
    defineTool(
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
    defineTool(
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
    defineTool(
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
    defineTool(
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
    defineTool(
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
    defineTool(
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
            if (!record) return callResult({ error: "Image not found" }, true);
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
    defineTool(
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
          const record = await cropRegisteredImage(projectDir, args.image_id, {
            x: args.x,
            y: args.y,
            width: args.width,
            height: args.height,
          });
          return await imageToolResult(projectDir, record);
        } catch (error) {
          return callResult(
            error instanceof Error ? error.message : "Failed to crop image",
            true,
          );
        }
      },
    ),
    defineTool(
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
            error instanceof Error ? error.message : "Failed to annotate image",
            true,
          );
        }
      },
    ),
  ];
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
