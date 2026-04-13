"use client";

import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ArrowLeftRightIcon } from "lucide-react";
import { Sidebar } from "./sidebar/sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { useFsStartup } from "@/hooks/use-fs-startup";

export function WorkspaceLayout() {
  useFsStartup();

  const [swapped, setSwapped] = useState(false);

  const editorPanel = (
    <Panel defaultSize={42.5} minSize={25}>
      <LatexEditor />
    </Panel>
  );

  const previewPanel = (
    <Panel defaultSize={42.5} minSize={25}>
      <PdfPreview />
    </Panel>
  );

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={15} minSize={10} maxSize={25}>
        <Sidebar />
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      {swapped ? previewPanel : editorPanel}

      <PanelResizeHandle className="group relative w-0.5 bg-border transition-colors hover:bg-ring">
        <button
          onClick={() => setSwapped((s) => !s)}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex size-6 items-center justify-center rounded-full border bg-background shadow-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent cursor-pointer"
          title="Swap editor and preview"
        >
          <ArrowLeftRightIcon className="size-3" />
        </button>
      </PanelResizeHandle>

      {swapped ? editorPanel : previewPanel}
    </PanelGroup>
  );
}
