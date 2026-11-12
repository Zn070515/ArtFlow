using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using W = DocumentFormat.OpenXml.Wordprocessing;
using S = DocumentFormat.OpenXml.Spreadsheet;

namespace ArtFlow.DocumentExport.Tests;

public sealed class RendererTests
{
    [Fact]
    public void WordDocumentCarriesTheTitleAndTableRows()
    {
        var bytes = WordDocumentRenderer.Render(ExportFixture.Request());
        using var stream = new MemoryStream(bytes);
        using var document = WordprocessingDocument.Open(stream, false);

        var body = document.MainDocumentPart!.Document!.Body!;
        Assert.Contains("2026 Singer Competition", body.InnerText!);
        var table = Assert.Single(body.Elements<W.Table>());
        Assert.Equal(3, table.Elements<W.TableRow>().Count());
        Assert.Contains("Bob & <Co>", table.InnerText!);

        AssertValid(document);
    }

    [Fact]
    public void WorkbookKeepsTextNumbersAndHeaders()
    {
        var bytes = WorkbookRenderer.Render(ExportFixture.Request("xlsx"));
        using var stream = new MemoryStream(bytes);
        using var document = SpreadsheetDocument.Open(stream, false);

        var worksheet = Assert.Single(document.WorkbookPart!.WorksheetParts).Worksheet!;
        var rows = worksheet.Descendants<S.Row>().ToList();
        Assert.Equal(3, rows.Count);
        Assert.Equal(
            new[] { "participantId", "name", "score" },
            rows[0].Elements<S.Cell>().Select(cell => cell.InlineString!.Text!.Text).ToArray());
        var score = rows[1].Elements<S.Cell>().Last();
        Assert.Equal(S.CellValues.Number, score.DataType!.Value);
        Assert.Equal("90", score.CellValue!.Text);

        AssertValid(document);
    }

    private static void AssertValid(OpenXmlPackage document)
    {
        var errors = new OpenXmlValidator().Validate(document).ToList();
        Assert.True(
            errors.Count == 0,
            string.Join("\n", errors.Select(error => $"{error.Id}: {error.Description}")));
    }
}
