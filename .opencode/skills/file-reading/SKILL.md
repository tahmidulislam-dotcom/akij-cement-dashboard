---
name: file-reading
description: Read and extract content from uploaded user files before working on them — docx, pdf, xlsx, csv, pptx, txt, images. Use whenever the user uploads a file or asks to work with an existing document, to understand its structure and content first.
---

# Reading Uploaded Files (file-reading)

Use whenever the user uploads or references an existing file (docx, pdf, xlsx, csv, pptx, txt, images) so you can understand its structure and content before building or editing.

## Steps

1. Locate the file path (check Downloads, project directory, or the path the user gave).
2. Dispatch to the right reader based on extension:

   - `.docx` → `python-docx`: `Document(path)`; read paragraphs + tables.
   - `.pdf` → `pypdf`: `PdfReader(path)`; extract per-page text.
   - `.xlsx`/`.xls` → `openpyxl` (data_only=True); note sheet names, dimensions, sample rows.
   - `.csv` → `pandas.read_csv(path, encoding='utf-8-sig')`.
   - `.pptx` → `python-pptx`; enumerate slides, shapes, and text frames.
   - `.txt`/`.md` → plain read.
   - images (`.png`, `.jpg`, `.jpeg`) → use the read tool's image attachment support or note the image exists if OCR is unavailable.

3. Summarize the content/structure to the user before making changes.

## Notes

- Always read before editing — never guess the structure of an existing file.
- If a file is corrupted or unsupported, report the issue instead of fabricating content.
- On Windows without Python on PATH, use `uv run --with openpyxl --with python-pptx --with python-docx --with pandas --with pypdf python script.py`.
