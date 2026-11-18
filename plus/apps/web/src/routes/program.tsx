import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";

import { fetchPublicProgram, PublicProgramNotFound } from "../api/public-results.js";

function formatProgramTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function ProgramPage() {
  const { publicCode } = useParams({ from: "/program/$publicCode" });
  const [hostMode, setHostMode] = useState(false);
  const query = useQuery({
    queryKey: ["public-program", publicCode],
    queryFn: () => fetchPublicProgram(publicCode),
    retry: false,
  });

  if (query.isPending) return <p className="console-state auth-loading">正在加载节目单…</p>;
  if (query.error instanceof PublicProgramNotFound) {
    return (
      <section className="console-state">
        <p className="eyebrow">PROGRAM · 节目单</p>
        <h1 className="console-page-title">节目单未发布或已撤回</h1>
        <p className="state-copy">主办方尚未发布节目单，或最新版本已撤回。</p>
        <p style={{ marginTop: 24 }}>
          <Link className="table-link" to="/e/$publicCode" params={{ publicCode }}>
            返回活动主页
          </Link>
        </p>
      </section>
    );
  }
  if (query.error !== null) return <p className="console-state form-error" role="alert">节目单暂时无法加载。</p>;
  const program = query.data;
  if (program === undefined) return null;

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontSize: hostMode ? 24 : 16 }}>
      <header style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
        <div>
          <p className="eyebrow">PROGRAM · 节目单</p>
          <h1>{program.activity.title}</h1>
          <p className="state-copy">公开码 {program.activity.publicCode}</p>
        </div>
        {program.entries.length === 0 ? null : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={hostMode} onChange={(event) => setHostMode(event.target.checked)} />
              主持大字
            </label>
            <button type="button" className="secondary-button" onClick={() => window.print()}>
              打印
            </button>
          </div>
        )}
      </header>
      {program.entries.length === 0 ? (
        <p className="state-copy">还没有已通过审核的节目。</p>
      ) : (
        <ol style={{ lineHeight: 1.8 }}>
          {program.entries.map((entry) => (
            <li key={entry.participantId} style={{ marginBottom: 12 }}>
              <strong>{entry.name}</strong>
              {entry.song === "" ? null : <span> · {entry.song}</span>}
              {entry.startsAt === null ? null : (
                <time dateTime={entry.startsAt} style={{ marginLeft: 8, opacity: 0.75 }}>
                  {formatProgramTime(entry.startsAt)}
                </time>
              )}
              {entry.note === "" ? null : <p style={{ margin: "4px 0 0", opacity: 0.8 }}>{entry.note}</p>}
            </li>
          ))}
        </ol>
      )}
      <p style={{ marginTop: 32 }}>
        <Link className="table-link" to="/results/$publicCode" params={{ publicCode }}>
          查看公开赛果
        </Link>
        {" · "}
        <Link className="table-link" to="/e/$publicCode" params={{ publicCode }}>
          返回活动主页
        </Link>
      </p>
    </main>
  );
}
