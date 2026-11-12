using System.Security.Cryptography;
using System.Text;

namespace ArtFlow.DocumentExport;

/// <summary>
/// The sidecar has no user identity. Its only credential is the shared token
/// configured on the API and the service; an empty configuration fails closed.
/// </summary>
public static class TokenGuard
{
    public static bool IsAuthorized(string? provided, string? expected)
    {
        if (string.IsNullOrEmpty(provided) || string.IsNullOrEmpty(expected)) return false;
        var left = Encoding.UTF8.GetBytes(provided);
        var right = Encoding.UTF8.GetBytes(expected);
        return CryptographicOperations.FixedTimeEquals(left, right);
    }
}
