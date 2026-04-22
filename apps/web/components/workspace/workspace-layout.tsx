"use client";

import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ArrowLeftRightIcon } from "lucide-react";
import { Sidebar } from "./sidebar/sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { useFsStartup } from "@/hooks/use-fs-startup";
import { ProjectSwitcherButton } from "@/components/project/project-switcher-button";

interface Props {
  current: string;
  recent: string[];
}

export function WorkspaceLayout({ current, recent }: Props) {
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
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b bg-background px-2 py-1">
        <ProjectSwitcherButton current={current} recent={recent} />
      </div>

      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={15} minSize={10} maxSize={25}>
          <Sidebar />
        </Panel>

        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

        {swapped ? previewPanel : editorPanel}

        <PanelResizeHandle className="group relative w-0.5 bg-border transition-colors hover:bg-ring">
          <button
            onClick={() => setSwapped((s) => !s)}
            className="absolute top-1/2 left-1/2 z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border bg-background opacity-0 shadow-sm transition-opacity hover:bg-accent group-hover:opacity-100"
            title="Swap editor and preview"
          >
            <ArrowLeftRightIcon className="size-3 text-foreground" />
          </button>
        </PanelResizeHandle>

        {swapped ? editorPanel : previewPanel}
      </PanelGroup>
    </div>
  );
}
