using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using S = DocumentFormat.OpenXml.Spreadsheet;

namespace ArtFlow.DocumentExport;

public static class WorkbookRenderer
{
    public static byte[] Render(ExportRequest request)
    {
        using var stream = new MemoryStream();
        using (var document = SpreadsheetDocument.Create(stream, SpreadsheetDocumentType.Workbook))
        {
            var workbookPart = document.AddWorkbookPart();
            workbookPart.Workbook = new S.Workbook();
            var worksheetPart = workbookPart.AddNewPart<WorksheetPart>();
            var sheetData = BuildSheetData(request);
            worksheetPart.Worksheet = new S.Worksheet(
                SheetViews(),
                Columns(request),
                sheetData);
            var sheets = workbookPart.Workbook.AppendChild(new S.Sheets());
            sheets.Append(new S.Sheet
            {
                Id = workbookPart.GetIdOfPart(worksheetPart),
                SheetId = 1,
                Name = "Export",
            });
            var stylesPart = workbookPart.AddNewPart<WorkbookStylesPart>();
            stylesPart.Stylesheet = Stylesheet();
        }
        return stream.ToArray();
    }

    private static S.SheetData BuildSheetData(ExportRequest request)
    {
        var sheetData = new S.SheetData();
        var header = new S.Row();
        foreach (var name in request.Headers)
        {
            header.Append(TextCell(name, header: true));
        }
        sheetData.Append(header);
        foreach (var row in request.Rows)
        {
            var line = new S.Row();
            foreach (var element in row)
            {
                ExportCells.TryRead(element, out var cell);
                line.Append(Cell(cell));
            }
            sheetData.Append(line);
        }
        return sheetData;
    }

    private static S.Cell Cell(ExportCell cell)
    {
        return cell.Kind switch
        {
            ExportCellKind.Number => new S.Cell
            {
                DataType = S.CellValues.Number,
                CellValue = new S.CellValue(cell.Text),
            },
            ExportCellKind.Boolean => new S.Cell
            {
                DataType = S.CellValues.Boolean,
                CellValue = new S.CellValue(cell.Text),
            },
            _ => TextCell(cell.Text, header: false),
        };
    }

    private static S.Cell TextCell(string value, bool header)
    {
        return new S.Cell
        {
            DataType = S.CellValues.InlineString,
            StyleIndex = header ? 1u : 0u,
            InlineString = new S.InlineString(new S.Text(value)),
        };
    }

    private static S.SheetViews SheetViews()
    {
        return new S.SheetViews(
            new S.SheetView(
                new S.Pane
                {
                    VerticalSplit = 1,
                    TopLeftCell = "A2",
                    ActivePane = S.PaneValues.BottomLeft,
                    State = S.PaneStateValues.Frozen,
                })
            { WorkbookViewId = 0 });
    }

    private static S.Columns Columns(ExportRequest request)
    {
        var columns = new S.Columns();
        for (var index = 0; index < request.Headers.Count; index += 1)
        {
            var longest = request.Headers[index].Length;
            foreach (var row in request.Rows)
            {
                ExportCells.TryRead(row[index], out var cell);
                if (cell.Kind == ExportCellKind.Text && cell.Text.Length > longest)
                {
                    longest = cell.Text.Length;
                }
            }
            columns.Append(new S.Column
            {
                Min = (uint)(index + 1),
                Max = (uint)(index + 1),
                Width = Math.Clamp(longest + 2, 10, 40),
                CustomWidth = true,
            });
        }
        return columns;
    }

    private static S.Stylesheet Stylesheet()
    {
        return new S.Stylesheet(
            new S.Fonts(
                new S.Font(new S.FontSize { Val = 11 }, new S.FontName { Val = "Calibri" }),
                new S.Font(new S.Bold(), new S.FontSize { Val = 11 }, new S.FontName { Val = "Calibri" }))
            { Count = 2 },
            new S.Fills(
                new S.Fill(new S.PatternFill { PatternType = S.PatternValues.None }),
                new S.Fill(new S.PatternFill { PatternType = S.PatternValues.Gray125 }))
            { Count = 2 },
            new S.Borders(new S.Border()) { Count = 1 },
            new S.CellStyleFormats(new S.CellFormat()) { Count = 1 },
            new S.CellFormats(
                new S.CellFormat { FontId = 0, FillId = 0, BorderId = 0, FormatId = 0 },
                new S.CellFormat { FontId = 1, FillId = 0, BorderId = 0, FormatId = 0, ApplyFont = true })
            { Count = 2 });
    }
}
