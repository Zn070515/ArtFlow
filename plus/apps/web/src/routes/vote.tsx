import type { PublicVoteSession } from "@artflow-plus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useEffect } from "react";

import { ApiError } from "../api/client.js";
import { ensureBrowserIdentity, fetchPublicVote, redeemTicket, submitVote } from "../api/vote.js";

function readTicketCredential(): string {
  if (typeof window === "undefined") return "";
  const value = new URLSearchParams(window.location.hash.slice(1)).get("ticket");
  return value?.trim() ?? "";
}

function clearTicketCredential(): void {
  if (typeof window === "undefined" || window.location.hash === "") return;
  window.history.replaceState(window.history.state, document.title, window.location.pathname + window.location.search);
}

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
  if (code === "INVALID_TICKET" || code === "TICKET_REPLAYED" || code === "TICKET_SESSION_REVOKED" || code === "TICKET_SESSION_EXPIRED") {
    return "票据无效或已使用，请联系工作人员。";
  }
  return error instanceof Error ? error.message : String(error);
}

export function VotePage() {
  const { sessionId } = useParams({ from: "/vote/$sessionId" });
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [justVoted, setJustVoted] = useState(false);
  const [ticketCredential, setTicketCredential] = useState(readTicketCredential);
  const [fragmentCredential] = useState(readTicketCredential);
  const [autoRedeemStarted, setAutoRedeemStarted] = useState(false);

  const query = useQuery({
    queryKey: ["public-vote", sessionId],
    queryFn: () => loadSession(sessionId),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const redeem = useMutation({
    mutationFn: (credential: string) => redeemTicket(credential),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["public-vote", sessionId] });
    },
  });
  useEffect(() => {
    const session = query.data;
    const credential = fragmentCredential.trim();
    if (
      session?.status !== "open" ||
      session?.identityPolicy !== "ticket" ||
      session.ticketReady ||
      autoRedeemStarted ||
      credential === ""
    ) return;
    setAutoRedeemStarted(true);
    setTicketCredential("");
    clearTicketCredential();
    redeem.mutate(credential);
  }, [autoRedeemStarted, fragmentCredential, query.data, redeem]);
  const submit = useMutation({
    mutationFn: () => {
      const session = query.data;
      if (session === undefined) throw new Error("投票信息尚未加载。");
      return submitVote(
        session.activityId,
        sessionId,
        selected,
        session.identityPolicy === "anonymous"
          ? "anonymous"
          : session.identityPolicy === "ticket"
            ? "ticket"
            : "browser",
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
          ) : session.identityPolicy === "ticket" && !session.ticketReady ? (
            <>
              <p className="state-copy">本场需要现场票据，请先验证票据。</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const credential = ticketCredential.trim();
                  if (credential === "" || redeem.isPending) return;
                  setTicketCredential("");
                  clearTicketCredential();
                  redeem.mutate(credential);
                }}
              >
                <label>
                  票据凭证
                  <input
                    aria-label="票据凭证"
                    value={ticketCredential}
                    onChange={(event) => setTicketCredential(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button type="submit" className="button-primary" disabled={ticketCredential.trim() === "" || redeem.isPending}>
                  {redeem.isPending ? "验证中…" : "验证票据"}
                </button>
              </form>
            </>
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
          {submit.error === null && redeem.error === null ? null : (
            <p className="form-error" role="alert">{errorMessage(submit.error ?? redeem.error)}</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
