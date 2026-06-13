# Mneme PRD — Parsing/Library Stack License Audit

Assumption tested: "The parsing/library stack is license-clean (PRD names Docling / PyMuPDF for PDFs)."
Verdict: Feasible-with-caveats. PyMuPDF and ebooklib are AGPL flags; unstructured pulls AGPL/LGPL extras. Permissive substitutes exist for all three.

## License table (verified, primary sources)

| Library | License | Permissive? | Source |
|---|---|---|---|
| PyMuPDF (fitz) | AGPL-3.0 OR commercial (Artifex) | NO — FLAG | github.com/pymupdf/pymupdf, issue #4504 |
| Docling | MIT | YES | docling pyproject.toml license="MIT" |
| Docling PDF backends | pypdfium2 (BSD-3 + Apache-2.0, PDFium) + docling-parse | YES — no PyMuPDF dep | docling pyproject.toml |
| LanceDB | Apache-2.0 | YES | github.com/lancedb/lancedb |
| bge-m3 | MIT | YES | huggingface.co/BAAI/bge-m3 |
| bge-reranker-v2-m3 | Apache-2.0 | YES | huggingface.co/BAAI/bge-reranker-v2-m3 |
| Tantivy (+ tantivy-py) | MIT | YES | github.com/quickwit-oss/tantivy |
| watchdog | Apache-2.0 | YES | github.com/gorakhargosh/watchdog |
| python-docx | MIT | YES | github.com/python-openxml/python-docx |
| python-pptx | MIT | YES | github.com/scanny/python-pptx |
| ebooklib | AGPL-3.0-or-later | NO — FLAG | github.com/aerkalov/ebooklib setup.py |
| unstructured (core) | Apache-2.0 BUT extras pull AGPL/LGPL | CAVEAT — FLAG | unstructured issue #3894 |

## Key findings
1. PyMuPDF is AGPL-3.0/commercial dual. Under a permissive-only policy (sibling Cairn) this is a flag. Substitute: Docling (MIT) with pypdfium2 backend, or pdfminer.six (MIT) / pypdf (BSD). Docling does NOT depend on PyMuPDF — so the PRD's "Docling / PyMuPDF" should simply drop PyMuPDF.
2. ebooklib (EPUB, V1 stretch) is AGPL-3.0-or-later. Flag. Substitutes: parse EPUB as zip+XHTML via stdlib zipfile + lxml/BeautifulSoup, or run Docling/pandoc.
3. unstructured (HTML, V1 core) is Apache-2.0 itself but optional extras drag in ultralytics (AGPL-3.0), ultralytics-thop (AGPL-3.0), chardet (LGPL-2+). Issue #3894 (open, Jan 2025). For HTML only you need none of the AGPL ML extras; use trafilatura (Apache-2.0/GPL? verify) or readability-lxml / BeautifulSoup + lxml to stay clean. Pin extras carefully and audit the resolved tree.

## Net
The Cursor-style machinery (Merkle, content-hash embed cache, LanceDB, hybrid retrieval) is built entirely on permissive deps. Only the heterogeneous-parsing edge has copyleft traps, all avoidable. Not a blocker; it's a dependency-selection discipline item that the same author already exercised on Cairn.
