import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchPublicProgramme } from "../api/programme.js";
import { ApiError } from "../api/client.js";
import { ProgrammeView } from "../components/programme/ProgrammeView.js";

export function ProgrammePage() {
  const { publicCode } = useParams({ from: "/programme/$publicCode" });
  const query = useQuery({
    queryKey: ["public-programme", publicCode],
    queryFn: () => fetchPublicProgramme(publicCode),
    retry: false,
  });

  useEffect(() => {
    document.title = query.data === undefined
      ? `节目单 · ${publicCode}`
      : `${query.data.activityTitle} · 节目单`;
  }, [publicCode, query.data]);

  if (query.isPending) {
    return <p className="auth-loading">正在加载节目单…</p>;
  }
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <section className="result-state">
        <p className="eyebrow">NOT FOUND</p>
        <h1 className="state-title">没有找到这场活动的节目单</h1>
        <p className="state-copy">公开码「{publicCode}」不存在。</p>
        <Link className="state-link" to="/">返回</Link>
      </section>
    );
  }
  if (query.error !== null || query.data === undefined) {
    return <p className="form-error" role="alert">节目单暂时无法加载。</p>;
  }
  return (
    <section className="programme-page">
      <header className="console-page-header">
        <p className="eyebrow">PROGRAMME · 节目单</p>
        <h1 className="display landing-title">{query.data.activityTitle}</h1>
        <p className="state-copy">公开码 {query.data.publicCode}</p>
      </header>
      <ProgrammeView programme={query.data} variant="public" />
    </section>
  );
}
