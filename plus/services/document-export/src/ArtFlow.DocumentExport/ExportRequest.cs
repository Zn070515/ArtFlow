using System.Text.Json;
using System.Text.Json.Serialization;

namespace ArtFlow.DocumentExport;

/// <summary>
/// The Node API is the only producer of this document. It carries already
/// authorized table data, never a path, template, or database reference.
/// </summary>
public sealed class ExportRequest
{
    [JsonPropertyName("format")]
    public string Format { get; init; } = "";

    [JsonPropertyName("title")]
    public string Title { get; init; } = "";

    [JsonPropertyName("filenameStem")]
    public string FilenameStem { get; init; } = "";

    [JsonPropertyName("headers")]
    public List<string> Headers { get; init; } = new();

    [JsonPropertyName("rows")]
    public List<List<JsonElement>> Rows { get; init; } = new();
}

public enum ExportCellKind
{
    Text,
    Number,
    Boolean,
}

public readonly record struct ExportCell(string Text, ExportCellKind Kind);

public static class ExportCells
{
    public static bool TryRead(JsonElement element, out ExportCell cell)
    {
        cell = default;
        switch (element.ValueKind)
        {
            case JsonValueKind.String:
                var text = element.GetString() ?? "";
                if (text.Length > ExportRequestValidator.MaxCellLength || ExportRequestValidator.HasControl(text))
                {
                    return false;
                }
                cell = new ExportCell(text, ExportCellKind.Text);
                return true;
            case JsonValueKind.Number:
                if (!element.TryGetDouble(out var number) || !double.IsFinite(number))
                {
                    return false;
                }
                cell = new ExportCell(
                    number.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ExportCellKind.Number);
                return true;
            case JsonValueKind.True:
                cell = new ExportCell("1", ExportCellKind.Boolean);
                return true;
            case JsonValueKind.False:
                cell = new ExportCell("0", ExportCellKind.Boolean);
                return true;
            default:
                return false;
        }
    }
}
