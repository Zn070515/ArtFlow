using System.Text.Json;
using System.Text.Json.Serialization;
using ArtFlow.DocumentExport;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options =>
{
    // Hard transport ceiling. Row and header limits are validated after
    // parsing; a body that hits this limit gets 413, which the API reports as
    // EXPORT_TOO_LARGE instead of pretending the renderer is down.
    options.Limits.MaxRequestBodySize = 8 * 1024 * 1024;
});

var app = builder.Build();
var expectedToken = Environment.GetEnvironmentVariable("ARTFLOW_PLUS_EXPORT_TOKEN") ?? "";
var jsonOptions = new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = false,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    MaxDepth = 8,
};

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.MapPost("/v1/render", async (HttpRequest request, HttpResponse response) =>
{
    var provided = request.Headers["x-artflow-export-token"].ToString();
    if (!TokenGuard.IsAuthorized(provided, expectedToken))
    {
        return Results.Json(new { code = "UNAUTHORIZED" }, statusCode: StatusCodes.Status401Unauthorized);
    }
    if (!request.HasJsonContentType())
    {
        return Results.Json(new { code = "UNSUPPORTED_MEDIA_TYPE" }, statusCode: StatusCodes.Status415UnsupportedMediaType);
    }

    ExportRequest? payload;
    try
    {
        payload = await JsonSerializer.DeserializeAsync<ExportRequest>(request.Body, jsonOptions, request.HttpContext.RequestAborted);
    }
    catch (JsonException)
    {
        return Results.Json(new { code = "INVALID_INPUT" }, statusCode: StatusCodes.Status400BadRequest);
    }
    if (payload is null)
    {
        return Results.Json(new { code = "INVALID_INPUT" }, statusCode: StatusCodes.Status400BadRequest);
    }
    var validation = ExportRequestValidator.Validate(payload);
    if (!validation.Ok)
    {
        var status = validation.TooLarge
            ? StatusCodes.Status413PayloadTooLarge
            : StatusCodes.Status400BadRequest;
        return Results.Json(new { code = validation.TooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_INPUT", message = validation.Error }, statusCode: status);
    }

    var bytes = payload.Format == "docx"
        ? WordDocumentRenderer.Render(payload)
        : WorkbookRenderer.Render(payload);
    response.Headers["x-content-type-options"] = "nosniff";
    response.Headers.CacheControl = "no-store";
    app.Logger.LogInformation(
        "document-render format={Format} bytes={Bytes}",
        payload.Format,
        bytes.LongLength);
    return Results.File(
        bytes,
        DocumentTypes.For(payload.Format),
        $"{payload.FilenameStem}.{payload.Format}");
});

app.Run();

public static class DocumentTypes
{
    public const string Docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    public const string Xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    public static string For(string format) => format == "docx" ? Docx : Xlsx;
}
