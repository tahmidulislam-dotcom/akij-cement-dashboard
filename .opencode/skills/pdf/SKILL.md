---
name: pdf
description: Read, extract, and create PDF files. Use when reading uploaded PDFs (assessments, reports, payslips, study material), converting markdown/text to PDF, or building PDF reports.
---

# PDF Files (pdf)

Use when reading or creating PDFs: assessments, exam-prep study guides, reports, payslips, papers, converting markdown to PDF.

## Tooling

Python libraries (install via `uv run --with <pkg> python script.py` on Windows):

- Reading: `pypdf` (or `PyPDF2`) — `PdfReader(path)`; extract text per page. For scanned/image PDFs, OCR is not available locally — tell the user you need text-based PDFs or a viewer.
- Creation: `reportlab` (low-level) or convert via markdown → HTML → PDF (e.g., `weasyprint` or browser print). For simple text/markdown reports, `reportlab.platypus` with `SimpleDocTemplate`, `Paragraph`, `Spacer`, `Table` is reliable.

## Reading workflow

- `from pypdf import PdfReader; reader = PdfReader(path); text = page.extract_text()`.
- Handle multi-page documents; concatenate page text and preserve page boundaries when structure matters.

## Creating workflow

- Build with `reportlab.platypus`: `SimpleDocTemplate("out.pdf", pagesize=letter/A4)`, add `Paragraph`, `Table`, `Spacer`, then `doc.build(story)`.
- Set document title metadata; use A4 or Letter consistently.
- For markdown → PDF, convert to HTML with `markdown` then render with `weasyprint`.

## Verification

- Reopen the PDF with a reader and confirm page count and that key strings appear in extracted text. Report the file path.
