import * as QRCode from "qrcode";
import { useEffect, useState } from "react";

export interface QrCardProps {
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

export function QrCard({ title, description, url }: QrCardProps) {
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImage(null);
    void QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((data) => {
        if (!cancelled) setImage(data);
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <article className="print-card">
      <div className="print-card__qr">
        {image === null ? <span>正在生成…</span> : <img src={image} alt={`${title}二维码`} width={320} height={320} />}
      </div>
      <h2 className="print-card__title">{title}</h2>
      <p className="print-card__description">{description}</p>
      <p className="print-card__url">{url}</p>
    </article>
  );
}
