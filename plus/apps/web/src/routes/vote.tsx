import type { PublicVoteSession } from "@artflow-plus/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

import { ApiError } from "../api/client.js";
import { ensureBrowserIdentity, fetchPublicVote, submitVote } from "../api/vote.js";

async function loadSession(sessionId: string): Promise<PublicVoteSession> {
  const first = await fetchPublicVote(sessionId);
  if (first.identityPolicy !== "browser" || first.voted) return first;
  try {
    await ensureBrowserIdentity(first.activityId);
    return await fetchPublicVote(sessionId);
  } catch {
    return first;
  }
}

function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "DUPLICATE_BALLOT") return "这台设备已经投过票了。";
  if (code === "VOTE_SESSION_CLOSED") return "投票已结束。";
  if (code === "SESSION_NOT_RUNNING") return "投票尚未开始，请稍后再试。";
  if (code === "TOO_MANY_SELECTIONS") return "选择的候选超过上限。";
  if (code === "BALLOT_IDENTITY_INVALID") return "当前设备无法投票，请刷新后重试。";
  if (code === "ACTIVITY_NOT_ACTIVE") return "活动已结束。";
  return error instanceof Error ? error.message : String(error);
}

export function VotePage() {
  const { sessionId } = useParams({ from: "/vote/$sessionId" });
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [justVoted, setJustVoted] = useState(false);

  const query = useQuery({
    queryKey: ["public-vote", sessionId],
    queryFn: () => loadSession(sessionId),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const submit = useMutation({
    mutationFn: () => {
      const session = query.data;
      if (session === undefined) throw new Error("投票信息尚未加载。");
      return submitVote(
        session.activityId,
        sessionId,
        selected,
        session.identityPolicy === "anonymous" ? "anonymous" : "browser",
      );
    },
    onSuccess: () => setJustVoted(true),
  });

  const session = query.data;
  const voted = justVoted || session?.voted === true;

  function toggle(optionId: string): void {
    if (session === undefined) return;
    if (session.selectionType === "single") {
      setSelected([optionId]);
      return;
    }
    if (selected.includes(optionId)) {
      setSelected(selected.filter((id) => id !== optionId));
      return;
    }
    if (selected.length >= session.maxSelections) return;
    setSelected([...selected, optionId]);
  }

  return (
    <main className="vote-page">
      <header className="vote-header">
        <p className="eyebrow">VOTE · 投票</p>
        <h1 className="display">{session?.activityTitle ?? "投票"}</h1>
      </header>

      {query.isLoading ? <p className="state-copy">加载中…</p> : null}
      {query.error !== null ? (
        <p className="form-error" role="alert">
          {query.error instanceof ApiError && query.error.status === 404
            ? "投票链接无效或已失效。"
            : "投票信息暂时无法加载。"}
        </p>
      ) : null}

      {session !== undefined ? (
        <section className="vote-card">
          {justVoted ? (
            <p className="state-copy">投票成功，谢谢参与。</p>
          ) : session.status === "closed" ? (
            <p className="state-copy">投票已结束。</p>
          ) : session.identityPolicy === "ticket" ? (
            <p className="state-copy">本场需要现场票据，请联系工作人员。</p>
          ) : voted ? (
            <p className="state-copy">你已经投过票了。</p>
          ) : (
            <>
              <ul className="vote-candidates">
                {session.candidates.map((candidate) => (
                  <li key={candidate.optionId}>
                    <label className="vote-candidate">
                      <input
                        type={session.selectionType === "single" ? "radio" : "checkbox"}
                        name="candidate"
                        checked={selected.includes(candidate.optionId)}
                        onChange={() => toggle(candidate.optionId)}
                      />
                      <span>{candidate.candidateId}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {session.selectionType === "multi" ? (
                <p className="state-copy">
                  最多选择 {session.maxSelections} 个，已选 {selected.length} 个。
                </p>
              ) : null}
              <button
                type="button"
                className="button-primary"
                disabled={selected.length === 0 || submit.isPending}
                onClick={() => submit.mutate()}
              >
                投票
              </button>
            </>
          )}
          {submit.error === null || submit.error === undefined ? null : (
            <p className="form-error" role="alert">{errorMessage(submit.error)}</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
