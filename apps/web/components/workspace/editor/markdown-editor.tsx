"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { EditorState, Prec, StateField, StateEffect } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import {
  search,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery as setSearchQueryEffect,
  findNext,
  findPrevious,
} from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { useEditorStore } from "@/stores/editor-store";
import { EditorToolbar } from "./editor-toolbar";
import { ImagePreview } from "./image-preview";
import { SearchPanel } from "./search-panel";

/** StateEffect to set or clear the line-flash decoration in CodeMirror. */
const setFlashLineEffect = StateEffect.define<number | null>();
const lineFlashDeco = Decoration.line({ class: "goto-line-flash" });

/**
 * StateField that paints a single line with `.goto-line-flash` when a
 * goto-location jump lands there. The CSS fades the highlight; the field is
 * cleared from React via a timeout (clearFlashLine).
 */
const lineFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlashLineEffect)) {
        if (e.value == null) {
          decos = Decoration.none;
        } else {
          const lineNum = Math.max(1, Math.min(e.value, tr.state.doc.lines));
          const line = tr.state.doc.line(lineNum);
          decos = Decoration.set([lineFlashDeco.range(line.from)]);
        }
      }
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface StickyItem {
  level: number;
  content: string;
  html: string;
  line: number;
}

interface ParsedHeading {
  level: number;
  content: string;
  line: number;
}

/** ATX headings (`#` … `######`), skipping fenced code blocks. */
function parseMarkdownStructure(content: string): ParsedHeading[] {
  const lines = content.split("\n");
  const result: ParsedHeading[] = [];
  let inFence = false;

  lines.forEach((lineContent, index) => {
    if (/^\s*(```|~~~)/.test(lineContent)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = lineContent.match(/^(#{1,6})\s+\S/);
    if (match) {
      result.push({
        level: match[1].length,
        content: lineContent,
        line: index + 1,
      });
    }
  });
  return result;
}

/** The chain of headings enclosing `currentLine` (e.g. H1 › H2 › H3). */
function getStickyLines(
  headings: ParsedHeading[],
  currentLine: number,
): StickyItem[] {
  const stack: StickyItem[] = [];
  for (const item of headings) {
    if (item.line > currentLine) break;
    while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    stack.push({
      level: item.level,
      content: item.content,
      html: "",
      line: item.line,
    });
  }
  return stack;
}

export function MarkdownEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const activePath = useEditorStore((s) => s.activePath);
  const activeKind = useEditorStore((s) => s.activeKind);
  const buffer = useEditorStore((s) => s.buffer);
  const activeDataUrl = useEditorStore((s) => s.activeDataUrl);
  const loading = useEditorStore((s) => s.loading);
  const setBuffer = useEditorStore((s) => s.setBuffer);
  const pendingGoTo = useEditorStore((s) => s.pendingGoTo);
  const clearPendingGoTo = useEditorStore((s) => s.clearPendingGoTo);
  const flashLine = useEditorStore((s) => s.flashLine);
  const clearFlashLine = useEditorStore((s) => s.clearFlashLine);

  const isTextFile = activeKind === "text";

  const [imageScale, setImageScale] = useState(0.5);
  const [currentLine, setCurrentLine] = useState(1);
  const [gutterWidth, setGutterWidth] = useState(0);
  const [lineHtmlCache, setLineHtmlCache] = useState<Record<number, string>>(
    {},
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);

  const parsedHeadings = useMemo(() => parseMarkdownStructure(buffer), [buffer]);
  const stickyLines = useMemo(() => {
    const items = getStickyLines(parsedHeadings, currentLine);
    return items.map((item) => ({
      ...item,
      html: lineHtmlCache[item.line] || "",
    }));
  }, [parsedHeadings, currentLine, lineHtmlCache]);

  const isSearchOpenRef = useRef(false);
  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  useEffect(() => {
    if (!searchQuery || !buffer) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const regex = new RegExp(
      searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    const matches = buffer.match(regex);
    setMatchCount(matches?.length ?? 0);
    setCurrentMatch(matches && matches.length > 0 ? 1 : 0);
  }, [searchQuery, buffer]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const query = new SearchQuery({
      search: searchQuery,
      caseSensitive: false,
      literal: true,
    });
    view.dispatch({ effects: setSearchQueryEffect.of(query) });
    if (searchQuery) findNext(view);
  }, [searchQuery]);

  const handleFindNext = () => {
    const view = viewRef.current;
    if (!view) return;
    findNext(view);
    view.focus();
  };
  const handleFindPrevious = () => {
    const view = viewRef.current;
    if (!view) return;
    findPrevious(view);
    view.focus();
  };

  useEffect(() => {
    if (!containerRef.current || !isTextFile) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        setBuffer(update.state.doc.toString());
      }
    });

    const scrollListener = EditorView.domEventHandlers({
      scroll: (_, view) => {
        const scrollTop = view.scrollDOM.scrollTop;
        const lineBlock = view.lineBlockAtHeight(scrollTop);
        const lineNumber = view.state.doc.lineAt(lineBlock.from).number;
        setCurrentLine(lineNumber);

        const gutter = view.dom.querySelector(".cm-gutters");
        if (gutter) setGutterWidth(gutter.getBoundingClientRect().width);

        const cmLines = view.dom.querySelectorAll(".cm-line");
        const newCache: Record<number, string> = {};
        cmLines.forEach((el) => {
          const lineInfo = view.lineBlockAt(
            view.posAtDOM(el as HTMLElement, 0),
          );
          const ln = view.state.doc.lineAt(lineInfo.from).number;
          newCache[ln] = el.innerHTML;
        });
        setLineHtmlCache((prev) => ({ ...prev, ...newCache }));
      },
    });

    const editorKeymap = Prec.highest(
      keymap.of([
        {
          key: "Enter",
          run: (view) => {
            if (isSearchOpenRef.current) {
              findNext(view);
              return true;
            }
            return insertNewlineAndIndent(view);
          },
        },
        {
          key: "Shift-Enter",
          run: (view) => {
            if (isSearchOpenRef.current) {
              findPrevious(view);
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-f",
          run: () => {
            setIsSearchOpen(true);
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            if (isSearchOpenRef.current) {
              setIsSearchOpen(false);
              return true;
            }
            return false;
          },
        },
      ]),
    );

    const state = EditorState.create({
      doc: buffer,
      extensions: [
        editorKeymap,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        oneDark,
        syntaxHighlighting(oneDarkHighlightStyle),
        search(),
        highlightSelectionMatches(),
        lineFlashField,
        updateListener,
        scrollListener,
        EditorView.lineWrapping,
        scrollPastEnd(),
        EditorView.theme({
          "&": { height: "100%", fontSize: "14px" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-gutters": { paddingRight: "4px" },
          ".cm-lineNumbers .cm-gutterElement": {
            paddingLeft: "8px",
            paddingRight: "4px",
          },
          ".cm-content": { paddingLeft: "8px", paddingRight: "12px" },
          ".cm-searchMatch": {
            backgroundColor: "#facc15 !important",
            color: "#000 !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 1px #eab308",
          },
          ".cm-searchMatch-selected": {
            backgroundColor: "#f97316 !important",
            color: "#fff !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 2px #ea580c",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "rgba(100, 150, 255, 0.3)",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activePath, isTextFile, setBuffer]);

  // Goto-location target: move cursor to (line, column) and scroll into view.
  useEffect(() => {
    if (!pendingGoTo) return;
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const lineNum = Math.max(1, Math.min(pendingGoTo.line, doc.lines));
    const line = doc.line(lineNum);
    const column = Math.max(0, Math.min(pendingGoTo.column, line.length));
    const pos = line.from + column;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
    clearPendingGoTo();
  }, [pendingGoTo, clearPendingGoTo]);

  // Goto-location flash: paint a fading background on the target line.
  useEffect(() => {
    if (!flashLine) return;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setFlashLineEffect.of(flashLine.line) });
    const timer = setTimeout(() => {
      const v = viewRef.current;
      if (v) v.dispatch({ effects: setFlashLineEffect.of(null) });
      clearFlashLine();
    }, 1700);
    return () => clearTimeout(timer);
  }, [flashLine, clearFlashLine]);

  // Sync external buffer changes (e.g. watcher-driven reload) into CodeMirror.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile) return;
    const currentContent = view.state.doc.toString();
    if (currentContent !== buffer) {
      const prevSelection = view.state.selection.main;
      const newLen = buffer.length;
      const clampedAnchor = Math.min(prevSelection.anchor, newLen);
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: buffer },
        selection: { anchor: clampedAnchor },
      });
    }
  }, [buffer, isTextFile]);

  if (!activePath) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-muted-foreground text-sm">
        Select a file from the sidebar to start editing.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-muted-foreground text-sm">
        Loading {activePath}…
      </div>
    );
  }

  if (activeKind === "binary") {
    return (
      <div className="flex h-full flex-col bg-background">
        <EditorToolbar
          editorView={viewRef}
          fileType="image"
          imageScale={imageScale}
          onImageScaleChange={setImageScale}
        />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {activeDataUrl && (
            <ImagePreview
              file={{
                id: activePath,
                name: activePath,
                type: "image",
                dataUrl: activeDataUrl,
              }}
              scale={imageScale}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorToolbar editorView={viewRef} />
      {isSearchOpen && (
        <SearchPanel
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onClose={() => {
            setIsSearchOpen(false);
            setSearchQuery("");
            viewRef.current?.focus();
          }}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          matchCount={matchCount}
          currentMatch={currentMatch}
        />
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {stickyLines.length > 0 && (
          <div className="absolute inset-x-0 top-0 z-10 border-border border-b bg-[#282c34] font-mono text-[14px] leading-[1.4] shadow-md">
            {stickyLines.map((section) => (
              <div
                key={section.line}
                className="flex cursor-pointer items-center hover:bg-white/5"
                onClick={() => {
                  const view = viewRef.current;
                  if (!view) return;
                  const line = view.state.doc.line(section.line);
                  view.dispatch({
                    selection: { anchor: line.from },
                    effects: EditorView.scrollIntoView(line.from, {
                      y: "start",
                    }),
                  });
                  view.focus();
                }}
              >
                <span
                  className="shrink-0 bg-[#282c34] py-px text-right text-[#636d83]"
                  style={{ width: gutterWidth ? gutterWidth - 8 : 32 }}
                >
                  {section.line}
                </span>
                {section.html ? (
                  <span
                    className="py-px pl-5.5"
                    dangerouslySetInnerHTML={{ __html: section.html }}
                  />
                ) : (
                  <span className="py-px pl-5.5 text-[#abb2bf]">
                    {section.content}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
