"use client";

import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { usePdfStore } from "@/stores/pdf-store";
import { useEditorStore } from "@/stores/editor-store";
import { describeOutcome, syncInverse } from "@/lib/synctex";

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

/** Find the page element for a given page number. */
function findPageEl(
  container: HTMLElement,
  pageNum: number,
): HTMLElement | null {
  return container.querySelector(
    `[data-page-number="${pageNum}"]`,
  ) as HTMLElement | null;
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
  const synctexHighlight = usePdfStore((s) => s.synctexHighlight);
  const setSynctexHighlight = usePdfStore((s) => s.setSynctexHighlight);
  const goToLocation = useEditorStore((s) => s.goToLocation);
  const [highlightRect, setHighlightRect] = useState<{
    pageNum: number;
    left: number;
    top: number;
    width: number;
    height: number;
    key: number;
  } | null>(null);

  const file = useMemo(() => {
    // Capture current scroll position from the still-mounted previous PDF
    // before this render replaces it. After the new PDF loads we restore
    // this raw scrollTop — much simpler and more reliable than tracking
    // page numbers, since pagination rarely shifts across a recompile.
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
      setHighlightRect(null);

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

  // Inverse-sync on double click: PDF coord → editor jump.
  const handleDoubleClick = useCallback(
    async (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const pageEl = target.closest("[data-page-number]") as HTMLElement | null;
      if (!pageEl || !pdfDocRef.current) return;
      const pageNum = parseInt(
        pageEl.getAttribute("data-page-number") ?? "0",
        10,
      );
      if (!pageNum) return;

      const pdfPage = await pdfDocRef.current.getPage(pageNum);
      // Page view box: [x0, y0, x1, y1] in PDF points.
      const view = pdfPage.view;
      const pdfWidthPts = view[2] - view[0];
      const pdfHeightPts = view[3] - view[1];
      const pageRect = pageEl.getBoundingClientRect();
      const pxPerPointX = pageRect.width / pdfWidthPts;
      const pxPerPointY = pageRect.height / pdfHeightPts;
      const xPts = (e.clientX - pageRect.left) / pxPerPointX;
      const yPts = (e.clientY - pageRect.top) / pxPerPointY;

      const outcome = await syncInverse(pageNum, xPts, yPts);
      const message = describeOutcome(outcome);
      if (outcome.kind === "ok") {
        await goToLocation(
          outcome.value.file,
          outcome.value.line,
          outcome.value.column,
        );
      } else if (message) {
        toast(message);
      }
    },
    [goToLocation],
  );

  // Page-only scroll (sidebar sync-scroll, outline). For SyncTeX forward
  // sync we do precise top-aligned scrolling in the highlight effect below
  // so it lands directly on the target line, not the page top.
  useEffect(() => {
    if (!scrollToPage || !containerRef.current || numPages === 0) return;
    // If a synctex highlight is also pending, the highlight effect handles
    // the scroll (with line-level precision) — don't double-scroll here.
    if (synctexHighlight && synctexHighlight.page === scrollToPage) return;
    if (containerRef.current) {
      scrollToPageEl(containerRef.current, scrollToPage);
    }
    onScrollDone?.();
  }, [scrollToPage, numPages, onScrollDone, synctexHighlight]);

  // SyncTeX forward hit → scroll precisely to the target line and flash it.
  useEffect(() => {
    if (!synctexHighlight || !containerRef.current || numPages === 0) return;
    const { page, x, y, width, height, key } = synctexHighlight;

    let cancelled = false;
    let attempts = 0;
    const place = async () => {
      if (cancelled || !containerRef.current) return;
      const container = containerRef.current;
      const pageEl = findPageEl(container, page);
      const doc = pdfDocRef.current;
      if (!pageEl || pageEl.getBoundingClientRect().width === 0 || !doc) {
        if (attempts++ < 40) requestAnimationFrame(place);
        return;
      }
      const pdfPage = await doc.getPage(page);
      const view = pdfPage.view;
      const pdfWidthPts = view[2] - view[0];
      const pdfHeightPts = view[3] - view[1];
      const pageRect = pageEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const pxPerPointX = pageRect.width / pdfWidthPts;
      const pxPerPointY = pageRect.height / pdfHeightPts;

      // SyncTeX y is the baseline; the box extends upward by `height`.
      const leftPx = x * pxPerPointX;
      const topPx = (y - height) * pxPerPointY;
      const widthPx = Math.max(width * pxPerPointX, 4);
      const heightPx = Math.max(height * pxPerPointY, 8);
      if (cancelled) return;
      setHighlightRect({
        pageNum: page,
        left: leftPx,
        top: topPx,
        width: widthPx,
        height: heightPx,
        key,
      });

      // Scroll the rect into view unless it's already comfortably visible.
      // pageRect.top is the page's top relative to the viewport; the rect's
      // viewport-relative top is pageRect.top + topPx.
      const rectTopInViewport = pageRect.top + topPx;
      const rectBottomInViewport = rectTopInViewport + heightPx;
      const padding = 40; // px; gives the line some breathing room
      const above = rectTopInViewport - containerRect.top < padding;
      const below =
        rectBottomInViewport - containerRect.top >
        containerRect.height - padding;
      if (above || below) {
        // Align rect ~30% from the top — the same instinct as `y: "center"`
        // in CodeMirror.
        const targetTopInContainer =
          rectTopInViewport - containerRect.top + container.scrollTop;
        container.scrollTo({
          top: targetTopInContainer - containerRect.height * 0.3,
          behavior: "smooth",
        });
      }
      onScrollDone?.();
    };
    requestAnimationFrame(place);

    // Clear after the CSS animation length so re-trigger of identical coords
    // (with a new key) still produces a flash.
    const clearTimer = setTimeout(() => {
      if (!cancelled) {
        setHighlightRect(null);
        setSynctexHighlight(null);
      }
    }, 1700);

    return () => {
      cancelled = true;
      clearTimeout(clearTimer);
    };
  }, [synctexHighlight, numPages, setSynctexHighlight, onScrollDone]);

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
      <div
        className="flex flex-col items-center gap-4 p-4"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
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
          {Array.from({ length: numPages }, (_, i) => {
            const pageNum = i + 1;
            const showHighlight =
              highlightRect && highlightRect.pageNum === pageNum;
            return (
              <div key={pageNum} className="relative mb-4">
                <Page
                  pageNumber={pageNum}
                  scale={scale}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  className="shadow-lg"
                  onLoadSuccess={i === 0 ? handlePageLoadSuccess : undefined}
                />
                {showHighlight && (
                  <div
                    key={highlightRect.key}
                    className="synctex-flash pointer-events-none absolute"
                    style={{
                      left: highlightRect.left,
                      top: highlightRect.top,
                      width: highlightRect.width,
                      height: highlightRect.height,
                    }}
                  />
                )}
              </div>
            );
          })}
        </Document>
      </div>
    </div>
  );
}
