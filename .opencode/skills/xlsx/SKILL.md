---
name: xlsx
description: Create, read, and analyze Excel workbooks (.xlsx/.xls/.csv) using openpyxl and pandas. Use when building KPI scorecards, financial tables, data analysis workbooks, or when the user uploads or mentions an Excel, CSV, or spreadsheet file.
---

# Excel / Spreadsheet Workbooks (xlsx)

Use when the user needs Excel workbooks: KPI scorecards, financial tables, capacity studies, data analysis, or reading uploaded `.xlsx`/`.xls`/`.csv` files.

## Tooling

Python with `openpyxl` (and `pandas` for CSV/data work). On Windows use `uv run --with openpyxl --with pandas --with xlsxwriter python script.py` if Python is not on PATH.

## Reading files

- `.xlsx`/`.xls` → `openpyxl.load_workbook(path, data_only=True)` (data_only=True to get cached values, not formulas). Use `read_only=True` for large files.
- `.csv` → `pandas.read_csv(path)` (or `pd.read_csv(path, encoding='utf-8-sig')` to handle BOM).
- Inspect: sheet names, dimensions, and a sample of rows before building anything.

## Creating workbooks

Best practices:

- Import: `from openpyxl import Workbook`, `from openpyxl.styles import Font, PatternFill, Alignment, Border, Side`.
- Write with `ws.cell(row, col, value)` or `ws["A1"] = value`.
- Format headers: bold white font on a dark fill, frozen panes (`ws.freeze_panes`), column widths (`ws.column_dimensions["A"].width`), number formats (`cell.number_format = "#,##0"`).
- Add totals with formulas (`=SUM(...)`) or values; set `wb.calculation` trust if needed.
- One sheet per logical view; name sheets meaningfully.
- Save with `wb.save(path)`.

## Data analysis

- Use pandas for transforms (groupby, pivot, filters); write results back with `df.to_excel(writer, sheet_name=..., index=False)` using `pd.ExcelWriter`.
- Preserve source data; put derived/analysis output on separate sheets.

## Verification

After building, reopen the file with `openpyxl.load_workbook` and assert key cells/sheets exist. Confirm the file exists at the target path and report the path to the user.
