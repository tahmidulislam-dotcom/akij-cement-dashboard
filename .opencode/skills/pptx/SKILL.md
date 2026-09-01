---
name: pptx
description: Build, edit, and QA PowerPoint presentations (.pptx) using python-pptx. Use when creating slide decks, business/assessment presentations, revenue gap analysis, product/ops overviews, or when the user mentions a deck, slides, or presentation file.
---

# PowerPoint Presentations (pptx)

Use when creating or editing PowerPoint decks: business plans, assessment presentations, revenue gap / SBU analysis, product and ops overviews, KPI tiles.

## Tooling

Python with `python-pptx`. On Windows use `uv run --with python-pptx python script.py` if Python is not on PATH.

## Core workflow

- Import: `from pptx import Presentation`, `from pptx.util import Inches, Pt, Emu`, `from pptx.dml.color import RGBColor`, `from pptx.enum.text import PP_ALIGN`, `from pptx.enum.shapes import MSO_SHAPE`.
- Start from a blank presentation (`Presentation()`) and use blank layouts (`prs.slide_layouts[6]`) for full control, or copy an existing deck's layout.
- Set slide size to match target aspect (`prs.slide_width`, `prs.slide_height`); 16:9 is standard.
- Add title + content textboxes; keep consistent fonts, sizes, and color scheme across the deck (note: user often requests color revisions).
- Add shapes (`slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, ...)`) for feature cards/KPI tiles; set fill, line, and shadow.
- Tables: `slide.shapes.add_table(rows, cols, x, y, w, h)`; style header row.

## Charts

- Use `slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, ...)` for bar/column charts.
- Charts are frequently QA'd: check axis labels, number formats, legend, series names, and data values match the source numbers exactly.

## Verification

- Reopen the saved `.pptx` and assert slide count, required slide titles, and chart series exist.
- Render or open the file to confirm layout if possible; report the file path.
