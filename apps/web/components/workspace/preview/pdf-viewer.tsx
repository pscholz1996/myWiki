"use client";

import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Loader2Icon } from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PdfViewerProps {
  data: Uint8Array;
  scale: number;
  scrollToPage?: number | null;
  onError?: (error: string) => void;
  onLoadSuccess?: (numPages: number) => void;
  onScaleChange?: (scale: number) => void;
  onScrollDone?: () => void;
}

function scrollToPageEl(container: HTMLElement, pageNum: number) {
  const el = container.querySelector(`[data-page-number="${pageNum}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function PdfViewer({
  data,
  scale,
  scrollToPage,
  onError,
  onLoadSuccess,
  onScaleChange,
  onScrollDone,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasSetInitialScale = useRef(false);
  /** Raw scrollTop captured just before a new PDF replaces the old one. */
  const savedScrollTop = useRef<number | null>(null);
  const [numPages, setNumPages] = useState(0);
  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);

  const file = useMemo(() => {
    // Capture current scroll position from the still-mounted previous PDF
    // before this render replaces it. After the new PDF loads we restore
    // this raw scrollTop — much simpler and more reliable than tracking
    // page numbers, since pagination rarely shifts across a reload.
    if (containerRef.current) {
      savedScrollTop.current = containerRef.current.scrollTop;
    }
    const pdfData =
      data instanceof Uint8Array ? data : new Uint8Array(Object.values(data));
    return { data: pdfData.slice() };
  }, [data]);

  const handleLoadSuccess = useCallback(
    (pdf: pdfjs.PDFDocumentProxy) => {
      setNumPages(pdf.numPages);
      onLoadSuccess?.(pdf.numPages);
      pdfDocRef.current = pdf;

      // Restore the raw scroll position we captured before the swap. Poll
      // because pages render asynchronously: scrollTop is clamped to
      // scrollHeight, so setting it before pages have mounted would clip
      // to the bottom of the current (still small) document.
      const target = savedScrollTop.current;
      if (target == null) return;
      let attempts = 0;
      const restore = () => {
        const container = containerRef.current;
        if (!container) return;
        if (container.scrollHeight <= target + container.clientHeight) {
          // Document hasn't grown tall enough yet — wait another frame.
          if (attempts++ < 60) requestAnimationFrame(restore);
          return;
        }
        container.scrollTop = target;
        savedScrollTop.current = null;
      };
      requestAnimationFrame(restore);
    },
    [onLoadSuccess],
  );

  const handlePageLoadSuccess = useCallback(
    ({ width }: { width: number }) => {
      if (hasSetInitialScale.current) return;
      if (containerRef.current && onScaleChange) {
        hasSetInitialScale.current = true;
        const containerWidth = containerRef.current.clientWidth - 32;
        const fitScale = containerWidth / width;
        onScaleChange(Math.min(fitScale, 2));
      }
    },
    [onScaleChange],
  );

  const handleLoadError = useCallback(
    (error: Error) => {
      onError?.(error.message);
    },
    [onError],
  );

  // Handle clicks on internal PDF links (annotation layer).
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    if (!href.startsWith("#") || !containerRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const dest = href.slice(1);
    const doc = pdfDocRef.current;
    if (!doc) return;
    doc
      .getDestination(dest)
      .then(async (resolved) => {
        if (!resolved) return;
        const pageIndex = await doc.getPageIndex(resolved[0]);
        if (containerRef.current) {
          scrollToPageEl(containerRef.current, pageIndex + 1);
        }
      })
      .catch(() => {});
  }, []);

  // Page scroll requests (citation jumps, outline clicks).
  useEffect(() => {
    if (!scrollToPage || !containerRef.current || numPages === 0) return;
    scrollToPageEl(containerRef.current, scrollToPage);
    onScrollDone?.();
  }, [scrollToPage, numPages, onScrollDone]);

  // Ctrl+scroll zoom.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        onScaleChange(Math.max(0.25, Math.min(4, scale + delta)));
      }
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [scale, onScaleChange]);

  return (
    <div ref={containerRef} className="flex-1 overflow-auto">
      <div className="flex flex-col items-center gap-4 p-4" onClick={handleClick}>
        <Document
          file={file}
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
          loading={
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading PDF...
            </div>
          }
        >
          {Array.from({ length: numPages }, (_, i) => (
            <div key={i + 1} className="relative mb-4">
              <Page
                pageNumber={i + 1}
                scale={scale}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="shadow-lg"
                onLoadSuccess={i === 0 ? handlePageLoadSuccess : undefined}
              />
            </div>
          ))}
        </Document>
      </div>
    </div>
  );
}
