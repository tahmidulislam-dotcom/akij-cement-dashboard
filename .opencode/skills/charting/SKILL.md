---
name: charting
description: Generate data visualizations (charts/graphs) with matplotlib and pandas for Excel scorecards, PowerPoint decks, and PDF reports. Use when creating charts, graphs, plots, or doing chart QA for KPI dashboards, revenue gap analysis, or presentation data.
---

# Data Visualization (charting)

Use when the user needs charts/graphs: KPI dashboards, revenue gap analysis, SBU comparisons, presentation visuals, or when doing "chart QA" on numbers.

## Tooling

Python with `matplotlib` (and `pandas`). On Windows use `uv run --with matplotlib --with pandas python script.py` if Python is not on PATH.

## Workflow

- Import: `import matplotlib.pyplot as plt`, `import pandas as pd`.
- Prefer explicit, consistent styling: `plt.style.use("seaborn-v0_8-whitegrid")` or set fig/axes params manually.
- Save with high DPI for decks: `fig.savefig(path, dpi=200, bbox_inches="tight")`.
- Choose chart type by data: column/bar for comparisons, line for trends, pie/donut for shares, stacked bars for composition.

## QA rules

- Verify every data point on the chart matches the source numbers exactly (this is the #1 thing reviewed in the user's past decks).
- Check axis labels, titles, legends, units, and number formatting.
- Use a consistent color palette; respect the user's requested color scheme (they often ask for color revisions).

## Output

- Export as `.png` at high resolution for embedding in pptx/docx/pdf.
- Report the output path and the values plotted.
