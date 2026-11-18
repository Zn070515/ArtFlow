export interface MaterialPreviewProps {
  readonly src: string;
  readonly contentType: string;
  readonly name: string;
  readonly compact?: boolean;
}

/**
 * Inline preview through the existing controlled content route. Images are
 * lazy, audio/video use Range-capable media elements, and documents fall back
 * to the authenticated download link.
 */
export function MaterialPreview({ src, contentType, name, compact = false }: MaterialPreviewProps) {
  const type = contentType.toLowerCase();
  const className = compact ? "material-preview material-preview--compact" : "material-preview";

  if (type.startsWith("image/")) {
    return (
      <a className={className} href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={name} loading="lazy" />
      </a>
    );
  }
  if (type.startsWith("audio/")) {
    return <audio className={className} src={src} controls preload="metadata" />;
  }
  if (type.startsWith("video/")) {
    return <video className={className} src={src} controls preload="metadata" />;
  }
  return (
    <a className={`${className} material-preview--file`} href={src} target="_blank" rel="noreferrer">
      打开或下载 {name}
    </a>
  );
}
