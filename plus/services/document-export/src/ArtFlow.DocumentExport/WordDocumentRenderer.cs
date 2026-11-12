using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace ArtFlow.DocumentExport;

public static class WordDocumentRenderer
{
    public static byte[] Render(ExportRequest request)
    {
        using var stream = new MemoryStream();
        using (var document = WordprocessingDocument.Create(stream, WordprocessingDocumentType.Document))
        {
            var mainPart = document.AddMainDocumentPart();
            mainPart.Document = new Document();
            var body = mainPart.Document.AppendChild(new Body());
            body.Append(Title(request.Title));
            body.Append(BuildTable(request));
            body.Append(new SectionProperties(
                new PageSize { Width = 11906, Height = 16838 },
                new PageMargin { Top = 1134, Right = 1134, Bottom = 1134, Left = 1134 }));
        }
        return stream.ToArray();
    }

    private static Paragraph Title(string title)
    {
        return new Paragraph(
            new Run(
                new RunProperties(new Bold(), new FontSize { Val = "32" }),
                new Text(title) { Space = SpaceProcessingModeValues.Preserve }));
    }

    private static Table BuildTable(ExportRequest request)
    {
        var table = new Table(
            new TableProperties(
                new TableWidth { Width = "5000", Type = TableWidthUnitValues.Pct },
                Borders()),
            new TableGrid(
                [.. request.Headers.Select(_ => new GridColumn { Width = "2000" })]));
        var header = new TableRow();
        foreach (var name in request.Headers)
        {
            header.Append(Cell(name, header: true));
        }
        table.Append(header);
        foreach (var row in request.Rows)
        {
            var line = new TableRow();
            foreach (var element in row)
            {
                ExportCells.TryRead(element, out var cell);
                line.Append(Cell(cell.Text, header: false));
            }
            table.Append(line);
        }
        return table;
    }

    private static TableBorders Borders()
    {
        return new TableBorders(
            new TopBorder { Val = BorderValues.Single, Size = 4, Color = "999999" },
            new LeftBorder { Val = BorderValues.Single, Size = 4, Color = "999999" },
            new BottomBorder { Val = BorderValues.Single, Size = 4, Color = "999999" },
            new RightBorder { Val = BorderValues.Single, Size = 4, Color = "999999" },
            new InsideHorizontalBorder { Val = BorderValues.Single, Size = 4, Color = "999999" },
            new InsideVerticalBorder { Val = BorderValues.Single, Size = 4, Color = "999999" });
    }

    private static TableCell Cell(string value, bool header)
    {
        var run = new Run();
        if (header)
        {
            run.Append(new RunProperties(new Bold()));
        }
        run.Append(new Text(value) { Space = SpaceProcessingModeValues.Preserve });
        var properties = new TableCellProperties(
            new TableCellWidth { Type = TableWidthUnitValues.Auto });
        if (header)
        {
            properties.Append(new Shading { Val = ShadingPatternValues.Clear, Fill = "F2F2F2" });
        }
        return new TableCell(properties, new Paragraph(run));
    }
}
