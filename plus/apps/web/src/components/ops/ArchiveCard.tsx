import { useQuery } from "@tanstack/react-query";

import { archiveFileUrl, fetchArchiveState } from "../../api/archive.js";
import { Card } from "../ui/Card.js";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function ArchiveCard({
  activityId,
  canManage,
}: {
  readonly activityId: string;
  readonly canManage: boolean;
}) {
  const query = useQuery({
    queryKey: ["ops-archive", activityId],
    queryFn: () => fetchArchiveState(activityId),
    enabled: canManage,
    retry: false,
  });

  if (!canManage) return null;
  if (query.isPending) {
    return (
      <Card className="archive-card">
        <p className="auth-loading">正在加载归档包…</p>
      </Card>
    );
  }
  if (query.error !== null && query.error !== undefined) {
    return (
      <Card className="archive-card">
        <p className="ui-field__error" role="alert">归档状态暂时无法加载。</p>
      </Card>
    );
  }

  const packages = query.data?.packages ?? [];
  return (
    <Card className="archive-card" data-testid="archive-card">
      <h2 className="ui-card__title">归档包</h2>
      {packages.length === 0 ? (
        <p className="ui-card__description">活动关闭后可以生成不可变归档包。</p>
      ) : (
        <ul className="seat-list">
          {packages.map((item) => (
            <li key={item.id} data-testid="archive-package-row">
              版本 {item.version} · {bytes(item.sizeBytes)} · {new Date(item.sealedAt).toLocaleString("zh-CN")}
              {" · "}
              <a
                className="table-link"
                href={archiveFileUrl(activityId, item.version)}
                download
              >
                下载{CURRENT_SUFFIX(item.isCurrent)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CURRENT_SUFFIX(isCurrent: boolean): string {
  return isCurrent ? "（当前）" : "";
}
