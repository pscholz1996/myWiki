"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
  BookOpenIcon,
  AlertCircleIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
  DownloadIcon,
  XIcon,
} from "lucide-react";
import { useViewerStore } from "@/stores/viewer-store";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

const PdfViewer = dynamic(
  () => import("./pdf-viewer").then((mod) => mod.PdfViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);

/**
 * Right-center pane: shows source PDFs (papers, books, norms) opened from the
 * file tree — and later, pages cited by the AI assistant.
 */
export function SourceViewer() {
  const path = useViewerStore((s) => s.path);
  const data = useViewerStore((s) => s.data);
  const loading = useViewerStore((s) => s.loading);
  const error = useViewerStore((s) => s.error);
  const scrollToPage = useViewerStore((s) => s.scrollToPage);
  const setScrollToPage = useViewerStore((s) => s.setScrollToPage);
  const close = useViewerStore((s) => s.close);

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState<number>(1.0);

  // Reset per-document view state when a different PDF is opened.
  useEffect(() => {
    setPdfError(null);
    setNumPages(0);
  }, [path]);

  const zoomIn = () => setScale((s) => Math.min(4, s + 0.1));
  const zoomOut = () => setScale((s) => Math.max(0.25, s - 0.1));

  const fileName = path?.split("/").pop() ?? null;

  const handleDownload = () => {
    if (!data || !fileName) return;
    const blob = new Blob([new Uint8Array(data)], {
      type: "application/pdf",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const renderContent = () => {
    if (!path) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <BookOpenIcon className="mb-4 size-16 text-muted-foreground/50" />
          <h2 className="mb-2 font-medium text-lg text-muted-foreground">
            Source Viewer
          </h2>
          <p className="text-center text-muted-foreground text-sm">
            Open a PDF from the sidebar to read it here.
          </p>
        </div>
      );
    }

    if (loading) {
      return (
        <div className="flex flex-1 items-center justify-center bg-muted/30">
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (error || pdfError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">
            Could not open PDF
          </h2>
          <p className="max-w-md text-center text-muted-foreground text-sm">
            {error ?? pdfError}
          </p>
        </div>
      );
    }

    if (!data) return null;

    return (
      <PdfViewer
        data={data}
        scale={scale}
        scrollToPage={scrollToPage}
        onError={setPdfError}
        onLoadSuccess={setNumPages}
        onScaleChange={setScale}
        onScrollDone={() => setScrollToPage(null)}
      />
    );
  };

  return (
    <div className="flex h-full flex-col bg-muted/50">
      <div className="flex h-9 items-center justify-between border-border border-b bg-background px-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <BookOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground text-xs">
            {fileName ?? "No source open"}
          </span>
        </div>

        {data && (
          <div className="flex shrink-0 items-center gap-0.5">
            <span className="mr-2 text-muted-foreground text-xs">
              {numPages} {numPages === 1 ? "page" : "pages"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={zoomOut}
              disabled={scale <= 0.25}
            >
              <MinusIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={zoomIn}
              disabled={scale >= 4}
            >
              <PlusIcon className="size-3.5" />
            </Button>
            <Select
              value={scale.toString()}
              onValueChange={(v) => setScale(Number(v))}
            >
              <SelectTrigger size="sm" className="h-6! w-auto text-xs">
                <SelectValue>{Math.round(scale * 100)}%</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ZOOM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleDownload}
              title="Download PDF"
            >
              <DownloadIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={close}
              title="Close"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {renderContent()}
    </div>
  );
}
