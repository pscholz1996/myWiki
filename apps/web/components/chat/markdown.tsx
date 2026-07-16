"use client";

import type { ComponentProps } from "react";
import { FileTextIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { MermaidBlock } from "./mermaid-block";

const WRAPPER_CLASS = [
  "text-sm leading-6",
  "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-base [&_h1]:font-semibold [&_h1:first-child]:mt-0",
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[0.95rem] [&_h2]:font-semibold [&_h2:first-child]:mt-0",
  "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3:first-child]:mt-0",
  "[&_strong]:font-semibold",
  // Chip-styled source labels (SmartLink) opt out of the prose underline.
  "[&_a:not(.source-chip)]:underline [&_a:not(.source-chip)]:underline-offset-2",
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-current/20 [&_blockquote]:pl-3 [&_blockquote]:opacity-80",
  "[&_hr]:my-3 [&_hr]:border-current/10",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:border-current/15 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border [&_td]:border-current/15 [&_td]:px-2 [&_td]:py-1",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/5 [&_pre]:p-2 [&_pre]:text-xs dark:[&_pre]:bg-white/10",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-black/5 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em] dark:[&_:not(pre)>code]:bg-white/10",
  "[&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1",
].join(" ");

// Source images (and any other embedded image) render as a framed figure;
// clicking opens the full-size PNG in a new tab. White backing keeps
// transparent PNGs readable in dark mode.
function FigureImage(props: ComponentProps<"img">) {
  if (!props.src || typeof props.src !== "string") return null;
  return (
    <a
      href={props.src}
      target="_blank"
      rel="noreferrer"
      className="my-3 block w-fit max-w-full cursor-zoom-in"
      title="Open full size"
    >
      <img
        src={props.src}
        alt={props.alt ?? ""}
        className="max-h-[28rem] max-w-full rounded-lg border bg-white object-contain p-1 shadow-sm"
        loading="lazy"
      />
    </a>
  );
}

// Inline source references — markdown links the assistant writes after
// source-grounded claims, targeting /api/ai/sources/<id>/file#page=N —
// render as compact clickable labels (matching the verified-citation chips)
// instead of underlined prose links. Every other link stays a normal link.
function SmartLink(props: ComponentProps<"a">) {
  const href = props.href ?? "";
  if (href.startsWith("/api/ai/sources/")) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="source-chip mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-full border px-1.5 py-px align-middle text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <FileTextIcon className="size-3 shrink-0" />
        {props.children}
      </a>
    );
  }
  return (
    <a {...props} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  );
}

// ```mermaid fences become live diagrams; every other code block renders
// normally. react-markdown wraps code blocks as <pre><code>, so the switch
// happens at the <pre> level to replace the whole block, not just its text.
function PreBlock(props: ComponentProps<"pre">) {
  const child = Array.isArray(props.children)
    ? props.children[0]
    : props.children;
  if (
    child &&
    typeof child === "object" &&
    "props" in child &&
    /\blanguage-mermaid\b/.test(
      (child.props as { className?: string }).className ?? "",
    )
  ) {
    const code = (child.props as { children?: unknown }).children;
    if (typeof code === "string") {
      return <MermaidBlock code={code} />;
    }
  }
  return <pre {...props} />;
}

export function AiMarkdown({ content }: { content: string }) {
  return (
    <div className={WRAPPER_CLASS}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ pre: PreBlock, img: FigureImage, a: SmartLink }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
