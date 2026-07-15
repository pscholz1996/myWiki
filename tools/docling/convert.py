"""Converts a document with Docling and emits page-anchored JSON on stdout.

Output shape (consumed by apps/web/lib/ai/docling.ts):

    {"pageCount": N, "pages": [{"page": 1, "text": "..."}, ...]}

Text is grouped per page in reading order, with tables exported as GitHub
markdown so column relationships survive into search chunks. Pages are the
anchor for myWiki's citations, so every emitted character must be
attributable to exactly one page.
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Path to the document (pdf, docx, pptx, html, ...)")
    args = parser.parse_args()

    # Import inside main so argparse errors stay fast even though docling's
    # import (torch etc.) takes seconds.
    from docling.document_converter import DocumentConverter
    from docling_core.types.doc import DocItemLabel, TableItem, TextItem

    converter = DocumentConverter()
    result = converter.convert(args.input)
    doc = result.document

    pages: dict[int, list[str]] = {}

    def page_of(item) -> int | None:
        if not getattr(item, "prov", None):
            return None
        return item.prov[0].page_no

    for item, _level in doc.iterate_items():
        page = page_of(item)
        if page is None:
            continue
        if isinstance(item, TableItem):
            markdown = item.export_to_markdown(doc)
            if markdown.strip():
                pages.setdefault(page, []).append(markdown)
        elif isinstance(item, TextItem):
            if item.label == DocItemLabel.PAGE_FOOTER:
                continue  # running footers add noise to every chunk
            text = (item.text or "").strip()
            if text:
                # Section headers get a markdown marker so chunk boundaries
                # (which split on structure-ish whitespace) respect them.
                if item.label == DocItemLabel.SECTION_HEADER:
                    text = f"## {text}"
                pages.setdefault(page, []).append(text)

    page_count = doc.num_pages() if callable(getattr(doc, "num_pages", None)) else len(pages)

    json.dump(
        {
            "pageCount": page_count,
            "pages": [
                {"page": page, "text": "\n".join(parts)}
                for page, parts in sorted(pages.items())
            ],
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
