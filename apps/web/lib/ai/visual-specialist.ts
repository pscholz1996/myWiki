import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  getImageRecord,
  imageUrl,
  rasterizeSvg,
  registerVisualImage,
} from "@/lib/ai/images";
import { getAiSourceRecord } from "@/lib/ai/knowledge-base";
import {
  callResult,
  createMyWikiTools,
  IMAGE_TOOL_NAMES,
} from "@/lib/ai/tools";

/**
 * Claude's remaining job in myWiki: everything visual.
 *
 * The chat itself runs on the institute LLM, which researches and writes
 * the answer. It hands two kinds of work over here, because they were
 * measured to be beyond it or were decided to stay with Claude:
 *
 * - extractSourceFigure: cut an original figure out of a source page. The
 *   institute model locates figures well but crops them too tight.
 * - createVisual: explain knowledge visually, in whatever form teaches it
 *   best — a Mermaid diagram, a custom drawn graphic, or deliberately none.
 *
 * Each call is a fresh, throwaway Claude session that sees only what the
 * task needs: the source pages for a figure, or the knowledge excerpt the
 * institute model passed along for a visual. It gets no access to the rest
 * of the library — what goes to the cloud is exactly what is shown here.
 */

const VISUAL_MODEL =
  process.env.MYWIKI_CLAUDE_VISUAL_MODEL?.trim() || "claude-opus-5-5";

// A figure is a handful of renders and crops; a drawn graphic a few preview
// rounds. Anything past this is a loop, not diligence.
const MAX_TURNS = 30;

export type VisualResult =
  | { ok: true; markdown: string; kind: "figure" | "mermaid" | "svg" }
  | { ok: false; reason: string };

interface SessionOptions {
  projectDir: string;
  systemPrompt: string;
  prompt: string;
  // Typed off the SDK itself: tools with different input shapes only fit
  // together the way createSdkMcpServer accepts them.
  tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>;
  signal?: AbortSignal;
}

/**
 * Runs one specialist session to completion. The result is whatever the
 * deliver tool recorded — never parsed out of Claude's prose, so a chatty
 * closing remark can't corrupt a URL or a diagram.
 */
async function runSession(
  options: SessionOptions,
  delivered: () => VisualResult | null,
): Promise<VisualResult> {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const session = query({
    prompt: options.prompt,
    options: {
      cwd: options.projectDir,
      model: VISUAL_MODEL,
      systemPrompt: options.systemPrompt,
      // Throwaway: nothing here belongs in the user's ~/.claude history.
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // No built-in tools (shell, file access) — only the ones below.
      tools: [],
      mcpServers: {
        visual: createSdkMcpServer({
          name: "visual",
          version: "0.1.0",
          alwaysLoad: true,
          tools: options.tools,
        }),
      },
      maxTurns: MAX_TURNS,
      abortController: abort,
    },
  });

  let failure: string | null = null;
  try {
    for await (const message of session) {
      if (message.type === "result" && message.subtype !== "success") {
        failure =
          ("errors" in message && message.errors?.[0]) || message.subtype;
      }
      if (delivered()) break;
    }
  } catch (error) {
    if (options.signal?.aborted) return { ok: false, reason: "Stopped." };
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    session.close();
  }

  return (
    delivered() ?? {
      ok: false,
      reason: failure
        ? `Claude could not finish the visual: ${failure}`
        : "Claude ended without delivering a visual.",
    }
  );
}

// ---------------------------------------------------------------------------
// Original figures from sources

const FIGURE_SYSTEM_PROMPT = [
  "You extract original figures from source documents for myWiki, a knowledge assistant over the user's own library. The answer text is written by another model; you deliver one clean image of one figure.",
  "",
  "Workflow:",
  "- PDF: view_page_image to see the page, then crop_image around the figure. PPTX: list_slide_images, then view_image on the right media entry (often already a clean figure; crop only if it carries extra content).",
  "- The crop must contain the ENTIRE figure: its title or banner, column/row headers, axis labels, legend and outer border — and nothing else: no body text, running headers, page numbers or neighbouring figures. When in doubt, a few pixels of white margin beat a cut-off label.",
  "- Look at every crop you make. If anything is cut off or page furniture slipped in, crop again from the page render. Never deliver an image you haven't checked.",
  "- If the figure is not on the given page, look at the pages directly before and after.",
  "- Annotate only when the task asks for it, with annotate_image: strictly additive pointers (circle, arrow, highlight, short label) that never cover the figure's own content.",
  "- Finish by calling deliver_figure exactly once — or deliver_no_figure if the source has no such figure.",
].join("\n");

export interface FigureRequest {
  sourceId: string;
  page?: number;
  slide?: number;
  /** What to find, e.g. "the Pert chart of the work packages". */
  figure: string;
  /** Optional marking, e.g. "circle WP3 and its incoming arrows". */
  annotate?: string;
}

export async function extractSourceFigure(
  projectDir: string,
  scopedSourceIds: string[] | undefined,
  request: FigureRequest,
  signal?: AbortSignal,
): Promise<VisualResult> {
  const source = await getAiSourceRecord(projectDir, request.sourceId);
  if (!source) return { ok: false, reason: "Source not found." };
  if (source.kind !== "pdf" && source.kind !== "pptx") {
    return {
      ok: false,
      reason: `"${source.originalName}" is a ${source.kind} source and has no figures to extract.`,
    };
  }

  let result: VisualResult | null = null;
  const imageTools = createMyWikiTools(projectDir, scopedSourceIds)
    .filter((entry) =>
      (IMAGE_TOOL_NAMES as readonly string[]).includes(entry.name),
    )
    .map((entry) =>
      tool(entry.name, entry.description, entry.shape, (args) =>
        entry.run(args as Record<string, unknown>),
      ),
    );

  const deliverFigure = tool(
    "deliver_figure",
    "Hand over the finished figure. Call exactly once, after you have looked at the image and it is clean.",
    {
      image_id: z.string(),
      description: z
        .string()
        .min(3)
        .max(120)
        .describe("Short alt text in the language of the task."),
    },
    async (args) => {
      const record = await getImageRecord(projectDir, args.image_id);
      if (!record) return callResult({ error: "Image not found" }, true);
      if (record.kind === "page-render") {
        return callResult(
          {
            error:
              "That is a whole page render. Crop the figure out first and deliver the crop.",
          },
          true,
        );
      }
      result = {
        ok: true,
        kind: "figure",
        markdown: `![${args.description}](${imageUrl(record)})\n*Source: ${record.attribution}*`,
      };
      return callResult({ delivered: true });
    },
  );

  const deliverNoFigure = tool(
    "deliver_no_figure",
    "Report that the source has no suitable figure for the task.",
    { reason: z.string().min(3) },
    async (args) => {
      result = { ok: false, reason: args.reason };
      return callResult({ delivered: true });
    },
  );

  const where = request.page
    ? `page ${request.page}`
    : request.slide
      ? `slide ${request.slide}`
      : "a page you locate first (no page was given)";

  const prompt = [
    `Source: "${source.metadata?.title ?? source.originalName}" (source_id ${source.id}, ${source.kind}${source.pageCount ? `, ${source.pageCount} pages` : ""}).`,
    `Find: ${request.figure}`,
    `Where: ${where}.`,
    request.annotate ? `Then annotate it: ${request.annotate}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return runSession(
    {
      projectDir,
      systemPrompt: FIGURE_SYSTEM_PROMPT,
      prompt,
      tools: [...imageTools, deliverFigure, deliverNoFigure],
      signal,
    },
    () => result,
  );
}

// ---------------------------------------------------------------------------
// Own visual explanations

const VISUAL_SYSTEM_PROMPT = [
  "You are the visual explainer of myWiki, a knowledge assistant over the user's own library. Another model researched the user's question and hands you the relevant knowledge. Your job is knowledge transfer: decide whether — and how — a visual makes that knowledge genuinely easier to understand, then produce it.",
  "",
  "Use only the knowledge you are given. Don't add facts, numbers or relations that aren't in it; simplify, structure and emphasise instead.",
  "",
  "Choose the form that teaches best for THIS question:",
  "- Mermaid diagram — only when the content is genuinely a flow, sequence, state machine or small graph AND it stays readable. Mermaid gets cluttered fast: beyond roughly a dozen nodes, or with many crossing edges, it stops explaining. Don't force it.",
  "- Custom SVG graphic — for everything Mermaid does badly: layered or schematic architectures, side-by-side comparisons, timelines and phases, matrices and quadrants, a V-model drawn as an actual V, concept sketches with callouts, simple quantitative charts.",
  "- No visual — when prose or a table already explains it better. That is a valid, honest result; say why.",
  "",
  "SVG rules — the SVG is rasterized by a limited renderer, and preview_svg shows you exactly what the user will see:",
  "- Root <svg> with explicit width, height and viewBox; about 800-1200 px wide.",
  "- Styling as inline presentation attributes (fill, stroke, font-size, font-weight). <style> blocks and CSS classes are IGNORED.",
  "- Arrowheads as small <path> triangles. <marker> is IGNORED and leaves bare lines.",
  '- No <foreignObject>, scripts, external images or web fonts. font-family="Segoe UI, Helvetica, Arial, sans-serif".',
  "- Light background, text at least 12 px with clear contrast, generous spacing, a clear reading direction, few colours used with meaning.",
  "- All labels in the language of the user's question.",
  "- Always call preview_svg and look at the result. Fix overlaps, clipped or cramped text and unclear arrows, then preview again before delivering.",
  "",
  "Mermaid rules: no `style`, `classDef` or colour directives (the app themes diagrams for light and dark mode), no HTML in labels except <br/>, short labels.",
  "",
  "Finish by calling deliver_visual exactly once.",
].join("\n");

export interface VisualRequest {
  /** The user's question, verbatim — the visual has to answer to it. */
  question: string;
  /** What the visual should make clear. */
  purpose: string;
  /** The facts to visualise, with their source labels. */
  knowledge: string;
  /** Short names of the sources, for the attribution line. */
  basedOn?: string;
}

export async function createVisual(
  projectDir: string,
  request: VisualRequest,
  signal?: AbortSignal,
): Promise<VisualResult> {
  let result: VisualResult | null = null;
  const basedOn = request.basedOn?.trim() || "your sources";

  const previewSvg = tool(
    "preview_svg",
    "Render an SVG exactly as the user will see it and look at it.",
    { svg: z.string().min(20) },
    async (args) => {
      try {
        const { png, width, height } = await rasterizeSvg(args.svg);
        return {
          content: [
            {
              type: "image",
              data: png.toString("base64"),
              mimeType: "image/png",
            },
            { type: "text", text: JSON.stringify({ width, height }) },
          ],
        } as CallToolResult;
      } catch (error) {
        return callResult(
          error instanceof Error ? error.message : "Could not render SVG",
          true,
        );
      }
    },
  );

  const deliverVisual = tool(
    "deliver_visual",
    'Hand over the result. kind "svg" or "mermaid" with its source in content; kind "none" with the reason in content when a visual would not help.',
    {
      kind: z.enum(["svg", "mermaid", "none"]),
      content: z.string().min(1),
      caption: z
        .string()
        .max(140)
        .optional()
        .describe(
          "One short line, in the question's language, saying what the visual shows.",
        ),
    },
    async (args) => {
      const caption = args.caption?.trim() || "Illustration";
      if (args.kind === "none") {
        result = { ok: false, reason: args.content };
        return callResult({ delivered: true });
      }
      if (args.kind === "mermaid") {
        const code = args.content
          .replace(/^```(?:mermaid)?\s*\n?/, "")
          .replace(/\n?```\s*$/, "");
        result = {
          ok: true,
          kind: "mermaid",
          markdown: `\`\`\`mermaid\n${code.trim()}\n\`\`\`\n*${caption} — own diagram (Claude), based on ${basedOn}*`,
        };
        return callResult({ delivered: true });
      }
      try {
        const { png, width, height } = await rasterizeSvg(args.content);
        const record = await registerVisualImage(projectDir, png, {
          width,
          height,
          attribution: `own illustration (Claude), based on ${basedOn}`,
        });
        result = {
          ok: true,
          kind: "svg",
          markdown: `![${caption}](${imageUrl(record)})\n*Source: ${record.attribution}*`,
        };
        return callResult({ delivered: true });
      } catch (error) {
        return callResult(
          error instanceof Error ? error.message : "Could not render SVG",
          true,
        );
      }
    },
  );

  const prompt = [
    `The user's question:\n${request.question}`,
    "",
    `What the visual should make clear:\n${request.purpose}`,
    "",
    `Knowledge to work from (from the user's library):\n${request.knowledge}`,
  ].join("\n");

  const outcome = await runSession(
    {
      projectDir,
      systemPrompt: VISUAL_SYSTEM_PROMPT,
      prompt,
      tools: [previewSvg, deliverVisual],
      signal,
    },
    () => result,
  );
  return outcome;
}
