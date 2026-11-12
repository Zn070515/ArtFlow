namespace ArtFlow.DocumentExport.Tests;

public sealed class TokenGuardTests
{
    [Fact]
    public void AcceptsTheExactToken()
    {
        Assert.True(TokenGuard.IsAuthorized("shared-secret", "shared-secret"));
    }

    [Fact]
    public void RejectsNearMissesAndEmptyConfiguration()
    {
        Assert.False(TokenGuard.IsAuthorized("shared-secret2", "shared-secret"));
        Assert.False(TokenGuard.IsAuthorized("", "shared-secret"));
        Assert.False(TokenGuard.IsAuthorized(null, "shared-secret"));
        Assert.False(TokenGuard.IsAuthorized("shared-secret", ""));
        Assert.False(TokenGuard.IsAuthorized("shared-secret", null));
    }
}
