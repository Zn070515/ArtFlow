import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { fetchPublicResults, PublicResultsNotFound } from "../api/public-results.js";
import { EmptyState, ErrorState, LoadingState, NotFoundState } from "../components/results/ResultStates.js";
import { ResultsView } from "../components/results/ResultsView.js";

export function ResultsRoute() {
  const { publicCode } = useParams({ from: "/results/$publicCode" });
  const query = useQuery({
    queryKey: ["public-results", publicCode],
    queryFn: ({ signal }) => fetchPublicResults(publicCode, signal),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    document.title =
      query.data === undefined
        ? `赛果 · ${publicCode}`
        : `${query.data.activityTitle} · 赛果公示`;
  }, [publicCode, query.data]);

  if (query.isPending) return <LoadingState />;
  if (query.error instanceof PublicResultsNotFound) return <NotFoundState publicCode={publicCode} />;
  if (query.error !== null) {
    return (
      <ErrorState
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (query.data.results.length === 0) {
    return <EmptyState activityTitle={query.data.activityTitle} />;
  }
  return (
    <>
      <p style={{ textAlign: "center" }}>
        <Link className="table-link" to="/program/$publicCode" params={{ publicCode }}>
          查看节目单 / 主持手卡
        </Link>
      </p>
      <ResultsView data={query.data} />
    </>
  );
}
