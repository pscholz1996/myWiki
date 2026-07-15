"use client";

import { useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";
import { Loader2Icon } from "lucide-react";

/**
 * Renders a ```mermaid fenced code block from an AI answer as an actual
 * diagram. Renders lazily on the client (mermaid is a heavy dependency and
 * answers stream in progressively) and falls back to showing the raw code
 * when the diagram fails to parse — a streaming answer will contain
 * incomplete mermaid source until the block is fully received, so parse
 * errors are expected mid-stream and simply resolve on the next render.
 */
export function MermaidBlock({ code }: { code: string }) {
  const { resolvedTheme } = useTheme();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "neutral",
          fontFamily: "inherit",
        });
        // mermaid.render needs a DOM-unique id; useId's colons aren't valid
        // in the SVG id attribute it generates.
        const domId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
        const { svg: rendered } = await mermaid.render(domId, code.trim());
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
    };
  }, [code, reactId, resolvedTheme]);

  if (svg) {
    return (
      <div
        className="my-3 flex justify-center overflow-x-auto rounded-lg border bg-background p-3 [&_svg]:h-auto [&_svg]:max-w-full"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid output with securityLevel "strict"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  if (failed) {
    return (
      <pre className="my-2 overflow-x-auto rounded-md bg-black/5 p-2 text-xs dark:bg-white/10">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div className="my-3 flex items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-muted-foreground text-xs">
      <Loader2Icon className="size-3.5 animate-spin" />
      Rendering diagram…
    </div>
  );
}
