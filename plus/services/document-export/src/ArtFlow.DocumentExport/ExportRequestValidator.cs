using System.Text.RegularExpressions;

namespace ArtFlow.DocumentExport;

public readonly record struct ExportValidation(bool Ok, bool TooLarge, string Error)
{
    public static ExportValidation Valid => new(true, false, "");

    public static ExportValidation Invalid(string error) => new(false, false, error);

    public static ExportValidation TooBig(string error) => new(false, true, error);
}

public static class ExportRequestValidator
{
    public const int MaxRows = 50_000;
    public const int MaxHeaders = 50;
    public const int MaxHeaderLength = 100;
    public const int MaxCellLength = 4_000;
    public const int MaxTitleLength = 200;

    private static readonly Regex FilenameStemPattern = new(
        "^[A-Za-z0-9._-]{1,120}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static bool HasControl(string value)
    {
        foreach (var character in value)
        {
            if (character < 0x20 || character == 0x7f) return true;
        }
        return false;
    }

    public static ExportValidation Validate(ExportRequest request)
    {
        if (request.Format is not ("docx" or "xlsx"))
        {
            return ExportValidation.Invalid("format must be docx or xlsx");
        }
        if (request.FilenameStem is null || !FilenameStemPattern.IsMatch(request.FilenameStem))
        {
            return ExportValidation.Invalid("filenameStem is invalid");
        }
        if (request.Title is null || request.Title.Length == 0 || request.Title.Length > MaxTitleLength ||
            HasControl(request.Title))
        {
            return ExportValidation.Invalid("title is invalid");
        }
        if (request.Headers is null || request.Headers.Count == 0)
        {
            return ExportValidation.Invalid("headers must not be empty");
        }
        if (request.Headers.Count > MaxHeaders)
        {
            return ExportValidation.TooBig($"headers exceed {MaxHeaders}");
        }
        foreach (var header in request.Headers)
        {
            if (string.IsNullOrEmpty(header) || header.Length > MaxHeaderLength || HasControl(header))
            {
                return ExportValidation.Invalid("a header is invalid");
            }
        }
        if (request.Rows is null)
        {
            return ExportValidation.Invalid("rows must be an array");
        }
        if (request.Rows.Count > MaxRows)
        {
            return ExportValidation.TooBig($"rows exceed {MaxRows}");
        }
        foreach (var row in request.Rows)
        {
            if (row is null || row.Count != request.Headers.Count)
            {
                return ExportValidation.Invalid("every row must match the header count");
            }
            foreach (var element in row)
            {
                if (!ExportCells.TryRead(element, out _))
                {
                    return ExportValidation.Invalid("a cell is invalid");
                }
            }
        }
        return ExportValidation.Valid;
    }
}
