import type { MyEvent } from "../../api/me.js";
import { MaterialPreview } from "../materials/MaterialPreview.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MATERIAL_STATUS_LABELS: Readonly<Record<MyEvent["materials"][number]["status"], string>> = {
  uploaded: "已上传",
  approved: "已通过",
  needs_supplement: "需补交",
};

export function MeMaterialList({ event }: { readonly event: MyEvent }) {
  return (
    <section className="me-detail__section">
      <h2>材料</h2>
      {event.materials.length === 0 ? (
        <p className="state-copy">还没有上传材料。</p>
      ) : (
        <ul className="me-material-list">
          {event.materials.map((material) => (
            <li key={material.id}>
              <div>
                <strong>{material.originalName}</strong>
                <span> · {formatBytes(material.byteLength)} · {MATERIAL_STATUS_LABELS[material.status]}</span>
                {material.reviewNote === "" ? null : (
                  <p className="ui-card__description">审核备注：{material.reviewNote}</p>
                )}
              </div>
              {material.contentPath === null ? (
                <span className="ui-card__description">由主办方上传</span>
              ) : (
                <div className="material-preview-actions">
                  <MaterialPreview
                    src={material.contentPath}
                    contentType={material.contentType}
                    name={material.originalName}
                    compact
                  />
                  <a className="ui-button ui-button--secondary ui-button--sm" href={material.contentPath}>
                    下载
                  </a>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
