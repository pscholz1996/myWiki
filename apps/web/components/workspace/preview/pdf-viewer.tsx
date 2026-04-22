"use client";

import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { LoaderIcon } from "lucide-react";
import { usePdfStore } from "@/stores/pdf-store";

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
  const savedPageNum = useRef(1);
  const savedPageFraction = useRef(0);
  const [numPages, setNumPages] = useState(0);
  // Map of named destination → 1-indexed page number, built on PDF load.
  const destMapRef = useRef<Map<string, number>>(new Map());
  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);

  const file = useMemo(() => {
    // Before remount: find which page is at the top of the viewport and how
    // far into it we've scrolled (as a fraction). This survives page-height
    // changes between recompiles.
    const container = containerRef.current;
    if (container) {
      const pages = container.querySelectorAll("[data-page-number]");
      const containerTop = container.getBoundingClientRect().top;
      for (const page of pages) {
        const rect = page.getBoundingClientRect();
        if (rect.bottom > containerTop) {
          savedPageNum.current = parseInt(
            page.getAttribute("data-page-number") ?? "1",
            10,
          );
          const scrolledPast = containerTop - rect.top;
          savedPageFraction.current =
            rect.height > 0 ? scrolledPast / rect.height : 0;
          break;
        }
      }
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

      // Build destination map from PDF outline for internal link navigation.
      pdf
        .getOutline()
        .then(async (outline) => {
          const map = new Map<string, number>();
          if (!outline) return;
          const stack = [...outline];
          while (stack.length) {
            const item = stack.pop();
            if (!item) continue;
            if (item.dest) {
              try {
                const dest =
                  typeof item.dest === "string"
                    ? await pdf.getDestination(item.dest)
                    : item.dest;
                if (dest) {
                  const pageIndex = await pdf.getPageIndex(dest[0]);
                  if (item.title) map.set(item.title, pageIndex + 1);
                  if (typeof item.dest === "string")
                    map.set(item.dest, pageIndex + 1);
                }
              } catch {
                // skip unresolvable
              }
            }
            if (item.items) stack.push(...item.items);
          }
          destMapRef.current = map;
          // Push to store so sidebar and editor-store can look up pages.
          usePdfStore.getState().setOutlineMap(map);
        })
        .catch(() => {});

      // Restore scroll position once pages have rendered. Poll because
      // onLoadSuccess fires before <Page> components mount.
      let attempts = 0;
      const restore = () => {
        const container = containerRef.current;
        if (!container) return;
        const target = container.querySelector(
          `[data-page-number="${savedPageNum.current}"]`,
        ) as HTMLElement | null;
        if (!target || target.getBoundingClientRect().height === 0) {
          if (attempts++ < 30) requestAnimationFrame(restore);
          return;
        }
        // Use getBoundingClientRect (matching the save phase) so the
        // position is independent of the CSS offsetParent chain.
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetTop =
          targetRect.top - containerRect.top + container.scrollTop;
        container.scrollTop =
          targetTop + targetRect.height * savedPageFraction.current;
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

    // Check annotation layer links.
    const link = target.closest("a[href]") as HTMLAnchorElement | null;
    if (link) {
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#") && containerRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const dest = href.slice(1);

        // Try pre-built map first (fast).
        const mapped = destMapRef.current.get(dest);
        if (mapped) {
          scrollToPageEl(containerRef.current, mapped);
          return;
        }

        // Fall back to runtime resolution.
        const doc = pdfDocRef.current;
        if (doc) {
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
        }
        return;
      }
    }
  }, []);

  // Scroll to a specific page (from sidebar sync-scroll or outline).
  useEffect(() => {
    if (!scrollToPage || !containerRef.current || numPages === 0) return;
    const timer = setTimeout(() => {
      if (containerRef.current) {
        scrollToPageEl(containerRef.current, scrollToPage);
      }
      onScrollDone?.();
    }, 200);
    return () => clearTimeout(timer);
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
      <div
        className="flex flex-col items-center gap-4 p-4"
        onClick={handleClick}
      >
        <Document
          file={file}
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
          loading={
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Loading PDF...
            </div>
          }
        >
          {Array.from({ length: numPages }, (_, i) => (
            <Page
              key={i + 1}
              pageNumber={i + 1}
              scale={scale}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className="mb-4 shadow-lg"
              onLoadSuccess={i === 0 ? handlePageLoadSuccess : undefined}
            />
          ))}
        </Document>
      </div>
    </div>
  );
}
