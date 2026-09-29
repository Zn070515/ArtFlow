function Resolve-ComposeSharedNetwork {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$DockerExecutable,
        [Parameter(Mandatory = $true)][string]$FirstContainer,
        [Parameter(Mandatory = $true)][string]$SecondContainer
    )

    function Get-NetworkNames {
        param([Parameter(Mandatory = $true)][string]$ContainerName)

        $json = & $DockerExecutable inspect --format '{{json .NetworkSettings.Networks}}' $ContainerName
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect Docker networks for $ContainerName."
        }
        try {
            $networkMap = $json | ConvertFrom-Json
        }
        catch {
            throw "Docker returned invalid network metadata for $ContainerName."
        }
        if ($null -eq $networkMap) {
            return @()
        }
        return @($networkMap.PSObject.Properties.Name)
    }

    $firstNetworks = @(Get-NetworkNames -ContainerName $FirstContainer)
    $secondNetworks = @(Get-NetworkNames -ContainerName $SecondContainer)
    $sharedNetworks = @(
        $firstNetworks | Where-Object { $secondNetworks -contains $_ }
    )
    if ($sharedNetworks.Count -ne 1) {
        throw "Expected exactly one shared Docker network between $FirstContainer and $SecondContainer."
    }
    return [string]$sharedNetworks[0]
}
