---
name: docx
description: Read, create, and format Word documents (.docx) using python-docx. Use when building CVs/resumes, reading job descriptions or briefs, composing reports/letters, or when the user mentions a Word document.
---

# Word Documents (docx)

Use when creating or reading Word documents: CVs/resumes, job descriptions, structure briefs, reports, letters, checklists.

## Tooling

Python with `python-docx`. On Windows use `uv run --with python-docx python script.py` if Python is not on PATH.

## Reading

- `from docx import Document`; `doc = Document(path)`.
- Iterate `doc.paragraphs` and `doc.tables` to extract content. Preserve paragraph order and note table structure.

## Creating documents

- Use `doc.add_heading(level=...)`, `doc.add_paragraph()`, `doc.add_table()`.
- Style with runs: `run.bold`, `run.italic`, `run.font.size`, `run.font.color.rgb`.
- For multi-page documents (e.g., ATS-friendly CVs), control page breaks: `from docx.enum.text import WD_BREAK`; `run.add_break(WD_BREAK.PAGE)`, and set section spacing via `doc.sections[0]`.
- Set page margins via sections; use a consistent typeface (e.g., Calibri 10-11pt for CVs).
- Tables: set widths, header shading, and borders for readability.

## CV/resume specifics

- One page or clearly sectioned pages; use page breaks between major sections.
- Use ATS-friendly structure: standard section headings, single-column layout, no images/icons, simple fonts.

## Verification

- Reopen the file and assert required paragraphs/sections and page-break behavior. Report the saved path.
