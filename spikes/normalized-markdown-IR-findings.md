# Feasibility: "normalized-markdown-IR" (Mneme PRD §5/§5.2/§6)

Verdict: **Feasible-with-caveats** · Confidence: High

## The crux: two IRs conflated
- §5 prose says "structured **Markdown**" (a string). §5.2 says "a list of typed **blocks**" (an object model). §6 line 114 says "after normalization **to Markdown**, run a splitter" — treating the markdown *string* as the IR.
- These are not the same. The typed-block list is the real IR; markdown is a **lossy serialization** of it.
- Docling and unstructured were both built exactly this way: a typed object model is the IR; markdown/HTML are *exports*.

## Evidence
- Docling `DoclingDocument`: Pydantic typed tree (TextItem/TableItem/PictureItem, body/furniture/groups), bbox for all items + provenance (page numbers). https://docling-project.github.io/docling/concepts/docling_document/
- Docling: JSON = full schema preservation (bbox + page provenance); Markdown = only "Partial (headings, lists, tables)". Markdown/HTML exports "cannot retain all available meta information." https://deepwiki.com/docling-project/docling/8.1-export-formats
- unstructured: Table elements store raw text in `.text` AND structured HTML in `.metadata.text_as_html`. Existence of text_as_html = proof markdown can't carry table structure. Metadata carries coordinates (bbox), page_number, parent_id (hierarchy). https://docs.unstructured.io/ui/document-elements
- Markdown table loss is real/dated: Docling issue #1927 (opened 2025-07-10) — markdown export merged multi-`<p>` cell content `31` instead of preserving structure. https://github.com/docling-project/docling/issues/1927

## char_span sub-question (land it, don't hedge)
- "Offset within the document" is underspecified. PDF has NO canonical byte text stream (text reconstructed from positioned glyphs), so the only coherent meaning is **offset into the normalized text**, not original bytes.
- A markdown char offset does NOT round-trip to a PDF page region by itself. Citation needs page + bbox provenance — which a markdown string discards but DoclingDocument preserves. So §6's claim "this metadata IS the citation system" fails if the IR is a markdown string.

## License flag
- **PyMuPDF (named §5.1, §10) is AGPL-3.0 / commercial-dual (Artifex).** Conflicts with sibling project's permissive-only (MIT/Apache/BSD/MPL) policy. https://pymupdf.readthedocs.io/en/latest/about.html
- Docling = MIT (license=false). unstructured core = Apache-2.0. Mitigation: use Docling, drop PyMuPDF.

## Headline
Feasible because retrieval-only (stops at cited chunks; never reconstructs docs) — table/column lossiness degrades retrieval at margins, not fatal. BUT the design must commit to the typed-block list §5.2 already half-specifies, store tables as HTML (text_as_html), and carry page+bbox per block for citation. PDF-heavy corpus = lossy cases are the dominant input.
