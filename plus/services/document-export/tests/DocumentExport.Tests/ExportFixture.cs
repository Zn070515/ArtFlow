using System.Text.Json;

namespace ArtFlow.DocumentExport.Tests;

internal static class ExportFixture
{
    public static ExportRequest Request(string format = "docx") => new()
    {
        Format = format,
        Title = "2026 Singer Competition",
        FilenameStem = "activity-act_1-registrations",
        Headers = new List<string> { "participantId", "name", "score" },
        Rows = new List<List<JsonElement>>
        {
            new() { Json("\"p-1\""), Json("\"Alice\""), Json("90") },
            new() { Json("\"p-2\""), Json("\"Bob & <Co>\""), Json("87.5") },
        },
    };

    public static JsonElement Json(string raw)
    {
        using var document = JsonDocument.Parse(raw);
        return document.RootElement.Clone();
    }
}
