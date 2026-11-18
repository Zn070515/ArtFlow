import { useMutation, useQuery } from "@tanstack/react-query";
import * as QRCode from "qrcode";
import { useEffect, useState } from "react";

import { ApiError } from "../api/client.js";
import {
  fetchPublicCurrent,
  fetchPublicVoteEntry,
  lookupTicket,
  type PublicTicketLookup,
} from "../api/tickets-public.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";

function readCredential(): string {
  if (typeof window === "undefined") return "";
  const value = new URLSearchParams(window.location.hash.slice(1)).get("ticket");
  return value?.trim() ?? "";
}

function errorCopy(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "TICKET_REVOKED") return "票据已撤销，请联系主办方。";
  if (code === "TICKET_EXPIRED") return "票据已过期。";
  if (code === "TICKET_ACTIVITY_NOT_PUBLIC") return "活动已结束或尚未公开。";
  return "票据无效，请确认链接完整。";
}

function ticketStateLabel(state: PublicTicketLookup["ticket"]["state"]): string {
  if (state === "issued") return "待领取";
  if (state === "redeemed") return "已领取";
  if (state === "revoked") return "已撤销";
  return "已过期";
}

export function TicketPage() {
  const [credential, setCredential] = useState(readCredential);
  const [input, setInput] = useState("");
  const [lookup, setLookup] = useState<PublicTicketLookup | undefined>();
  const [qr, setQr] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const lookupMutation = useMutation({ mutationFn: (value: string) => lookupTicket(value) });
  const publicCode = lookup?.activity.publicCode;
  const active = lookup?.activity.status === "active";
  const current = useQuery({
    queryKey: ["public-current", publicCode],
    queryFn: ({ signal }) => fetchPublicCurrent(publicCode ?? "", signal),
    enabled: publicCode !== undefined && active,
    refetchInterval: 30_000,
    retry: false,
  });
  const vote = useQuery({
    queryKey: ["public-vote-entry", publicCode],
    queryFn: ({ signal }) => fetchPublicVoteEntry(publicCode ?? "", signal),
    enabled: publicCode !== undefined && active,
    refetchInterval: 30_000,
    retry: false,
  });

  async function submit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("请输入入场凭证。");
      return;
    }
    setError(null);
    try {
      const data = await lookupMutation.mutateAsync(trimmed);
      setCredential(trimmed);
      setLookup(data);
      setQr(await QRCode.toDataURL(trimmed, { margin: 1, width: 240 }));
    } catch (caught) {
      setLookup(undefined);
      setQr(undefined);
      setError(errorCopy(caught));
    }
  }

  useEffect(() => {
    const value = readCredential();
    if (value !== "") void submit(value);
    // The fragment is read once on mount; manual retries use submit().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.title = lookup === undefined ? "电子票 · ArtFlow" : `${lookup.activity.title} · 入场票`;
  }, [lookup]);

  async function copyCredential(): Promise<void> {
    if (navigator.clipboard === undefined) {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2000);
      return;
    }
    try {
      await navigator.clipboard.writeText(credential);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <section className="ticket-page">
      <header className="ticket-header">
        <p className="eyebrow">E-TICKET · 入场票</p>
        <h1 className="ticket-title">{lookup?.activity.title ?? "电子票"}</h1>
        {lookup === undefined ? null : (
          <p className="ticket-meta">
            {lookup.activity.status === "closed" ? "已结束" : "入场凭证"} · 票号 {lookup.ticket.publicCode}
          </p>
        )}
      </header>
      {error === null ? null : <p className="ticket-error" role="alert">{error}</p>}
      {lookup === undefined ? (
        <div className="ticket-manual">
          <Input
            label="入场凭证"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="粘贴主办方发送的入场凭证"
          />
          <Button
            variant="primary"
            disabled={lookupMutation.isPending}
            onClick={() => void submit(input)}
          >
            {lookupMutation.isPending ? "正在校验…" : "查看票据"}
          </Button>
        </div>
      ) : (
        <>
          <div className="ticket-card">
            {qr === undefined ? null : (
              <img className="ticket-qr" src={qr} alt="入场二维码" width={240} height={240} />
            )}
            <p className="ticket-state">{ticketStateLabel(lookup.ticket.state)}</p>
            <p className="ticket-instruction">请在入场时出示二维码，或让工作人员输入下方凭证。</p>
            <p className="ticket-credential">{credential}</p>
            <div className="ticket-actions">
              <Button variant="secondary" size="sm" onClick={() => void copyCredential()}>
                复制凭证
              </Button>
              <Button variant="secondary" onClick={() => window.print()}>打印 / 保存</Button>
            </div>
            <span role="status">
              {copyState === "copied" ? "凭证已复制" : copyState === "failed" ? "复制失败，请手动复制" : ""}
            </span>
            <p className="ticket-hint">此链接包含入场凭证，请勿转发；轮换票据后旧链接失效。</p>
          </div>
          {active ? (
            <section className="ticket-live">
              <h2>现场</h2>
              {current.data?.current === undefined || current.data.current === null ? (
                <p>暂无当前节目</p>
              ) : (
                <p>当前：{current.data.current.title} · {current.data.current.slotLabel}</p>
              )}
              {current.data === undefined || current.data.next.length === 0 ? null : (
                <p>
                  接下来：{current.data.next.slice(0, 3).map((entry) => entry.title).join(" · ")}
                </p>
              )}
              {vote.data === null || vote.data === undefined ? null : (
                <a
                  className="ticket-vote"
                  href={`/vote/${encodeURIComponent(vote.data.sessionId)}#ticket=${encodeURIComponent(credential)}`}
                >
                  投票进行中 · 去投票
                </a>
              )}
            </section>
          ) : null}
          <p className="ticket-links">
            <a href={lookup.links.event}>活动主页</a>
            {" · "}
            <a href={lookup.links.results}>赛果</a>
          </p>
        </>
      )}
    </section>
  );
}
