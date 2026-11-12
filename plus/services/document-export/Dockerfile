# Build from the service directory:
#   docker build -t artflow-plus-export plus/services/document-export
ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:9.0
ARG DOTNET_RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:9.0

FROM ${DOTNET_SDK_IMAGE} AS build
WORKDIR /src
COPY Directory.Build.props Directory.Packages.props ./
COPY src/ArtFlow.DocumentExport/ArtFlow.DocumentExport.csproj src/ArtFlow.DocumentExport/
RUN dotnet restore src/ArtFlow.DocumentExport/ArtFlow.DocumentExport.csproj --locked-mode
COPY src/ArtFlow.DocumentExport/ src/ArtFlow.DocumentExport/
RUN dotnet publish src/ArtFlow.DocumentExport/ArtFlow.DocumentExport.csproj \
    -c Release -o /app --no-restore /p:UseAppHost=false

FROM ${DOTNET_RUNTIME_IMAGE}
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_RUNNING_IN_CONTAINER=true
EXPOSE 8080
USER $APP_UID
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["dotnet", "ArtFlow.DocumentExport.dll"]
