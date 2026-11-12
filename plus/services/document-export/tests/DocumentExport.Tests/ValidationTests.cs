namespace ArtFlow.DocumentExport.Tests;

public sealed class ValidationTests
{
    [Fact]
    public void AcceptsTheFixture()
    {
        Assert.True(ExportRequestValidator.Validate(ExportFixture.Request()).Ok);
    }

    [Theory]
    [InlineData("pdf")]
    [InlineData("")]
    public void RejectsAnUnknownFormat(string format)
    {
        var request = ExportFixture.Request();
        var invalid = new ExportRequest
        {
            Format = format,
            Title = request.Title,
            FilenameStem = request.FilenameStem,
            Headers = request.Headers,
            Rows = request.Rows,
        };
        Assert.False(ExportRequestValidator.Validate(invalid).Ok);
    }

    [Fact]
    public void RejectsAPathLikeFilenameStem()
    {
        Assert.False(ExportRequestValidator.Validate(WithStem("../etc/passwd")).Ok);
    }

    [Fact]
    public void RejectsARowThatDoesNotMatchTheHeaders()
    {
        var request = ExportFixture.Request();
        var invalid = new ExportRequest
        {
            Format = request.Format,
            Title = request.Title,
            FilenameStem = request.FilenameStem,
            Headers = request.Headers,
            Rows = new List<List<System.Text.Json.JsonElement>> { new() { ExportFixture.Json("\"only-one\"") } },
        };
        Assert.False(ExportRequestValidator.Validate(invalid).Ok);
    }

    [Fact]
    public void RejectsTooManyHeadersAsTooLarge()
    {
        var request = ExportFixture.Request();
        var headers = Enumerable.Range(0, ExportRequestValidator.MaxHeaders + 1).Select(index => $"h{index}").ToList();
        var invalid = new ExportRequest
        {
            Format = request.Format,
            Title = request.Title,
            FilenameStem = request.FilenameStem,
            Headers = headers,
            Rows = new List<List<System.Text.Json.JsonElement>>(),
        };
        var validation = ExportRequestValidator.Validate(invalid);
        Assert.False(validation.Ok);
        Assert.True(validation.TooLarge);
    }

    [Fact]
    public void RejectsControlCharactersInCells()
    {
        var request = ExportFixture.Request();
        var invalid = new ExportRequest
        {
            Format = request.Format,
            Title = request.Title,
            FilenameStem = request.FilenameStem,
            Headers = request.Headers,
            Rows = new List<List<System.Text.Json.JsonElement>>
            {
                new() { ExportFixture.Json("\"line\\nbreak\""), ExportFixture.Json("\"x\""), ExportFixture.Json("1") },
            },
        };
        Assert.False(ExportRequestValidator.Validate(invalid).Ok);
    }

    private static ExportRequest WithStem(string stem)
    {
        var request = ExportFixture.Request();
        return new ExportRequest
        {
            Format = request.Format,
            Title = request.Title,
            FilenameStem = stem,
            Headers = request.Headers,
            Rows = request.Rows,
        };
    }
}
