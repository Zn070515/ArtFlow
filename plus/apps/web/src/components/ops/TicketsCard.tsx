import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "../../api/client.js";
import type { IssuedTicket, TicketView } from "../../api/tickets.js";
import {
  fetchTicketingState,
  issueTicket,
  revokeTicket,
  revokeTicketSession,
  rotateTicket,
} from "../../api/tickets.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";

const TICKET_TONES: Readonly<Record<TicketView["state"], BadgeTone>> = {
  issued: "info",
  redeemed: "success",
  revoked: "warning",
  expired: "neutral",
};

const TICKET_LABELS: Readonly<Record<TicketView["state"], string>> = {
  issued: "已签发",
  redeemed: "已核销",
  revoked: "已撤销",
  expired: "已过期",
};

function humanError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "票据已被更新，请刷新后重试。";
  }
  return error instanceof Error ? error.message : "票据操作失败，请稍后重试。";
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

export function TicketsCard({
  activityId,
  canManage,
}: {
  readonly activityId: string;
  readonly canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<IssuedTicket | undefined>();
  const state = useQuery({
    queryKey: ["ops-ticketing", activityId],
    queryFn: () => fetchTicketingState(activityId),
    retry: false,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["ops-ticketing", activityId] });
  };
  const issue = useMutation({
    mutationFn: () => issueTicket(activityId, crypto.randomUUID()),
    onSuccess: (result) => {
      setIssued(result);
      refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (ticketId: string) => rotateTicket(activityId, ticketId, crypto.randomUUID()),
    onSuccess: (result) => {
      setIssued(result);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (ticketId: string) =>
      revokeTicket(activityId, ticketId, reason.trim(), crypto.randomUUID()),
    onSuccess: () => {
      setReason("");
      refresh();
    },
  });
  const revokeSession = useMutation({
    mutationFn: (sessionId: string) =>
      revokeTicketSession(activityId, sessionId, reason.trim(), crypto.randomUUID()),
    onSuccess: () => {
      setReason("");
      refresh();
    },
  });

  const error = issue.error ?? rotate.error ?? revoke.error ?? revokeSession.error;
  if (state.isPending) {
    return (
      <Card className="tickets-card">
        <p className="auth-loading">正在加载票据…</p>
      </Card>
    );
  }
  if (state.error !== null && state.error !== undefined) {
    return (
      <Card className="tickets-card">
        <p className="ui-field__error" role="alert">{humanError(state.error)}</p>
      </Card>
    );
  }

  const tickets = state.data?.tickets ?? [];
  const sessions = state.data?.sessions ?? [];
  return (
    <Card className="tickets-card" data-testid="tickets-card">
      <div className="tasks-card-header">
        <h2 className="ui-card__title">票据与入场</h2>
        <span className="analytics-readonly">{tickets.length} 张票据</span>
      </div>
      {canManage ? (
        <div className="task-actions">
          <Button variant="primary" disabled={issue.isPending} onClick={() => issue.mutate()}>
            签发新票据
          </Button>
        </div>
      ) : null}
      {issued === undefined ? null : (
        <div className="ticket-credential" role="status">
          <p className="ui-card__description">
            请立即记录：{issued.ticket.publicCode} · 凭证版本 {issued.ticket.credentialVersion}
          </p>
          <code className="ticket-credential__value">{issued.credential}</code>
          <p className="ui-card__description">凭证只显示一次；轮换后旧凭证立即失效。</p>
        </div>
      )}
      {tickets.length === 0 ? (
        <p className="ui-card__description">还没有票据。</p>
      ) : (
        <ul className="seat-list">
          {tickets.map((ticket) => (
            <li key={ticket.id} data-testid="ticket-row" data-ticket-state={ticket.state}>
              <Badge tone={TICKET_TONES[ticket.state]}>{TICKET_LABELS[ticket.state]}</Badge>{" "}
              {ticket.publicCode} · v{ticket.credentialVersion}
              {canManage && ticket.state === "issued" ? (
                <>
                  {" "}
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={rotate.isPending}
                    onClick={() => rotate.mutate(ticket.id)}
                  >
                    轮换凭证
                  </Button>
                </>
              ) : null}
              {canManage && ticket.state !== "revoked" && ticket.state !== "expired" ? (
                <>
                  {" "}
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={revoke.isPending || reason.trim() === ""}
                    onClick={() => revoke.mutate(ticket.id)}
                  >
                    撤销票据
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {sessions.length === 0 ? null : (
        <>
          <h3 className="ui-card__title">票据会话</h3>
          <ul className="seat-list">
            {sessions.map((session) => (
              <li key={session.id} data-testid="ticket-session-row">
                {shortId(session.ticketId)} · {new Date(session.expiresAt).toLocaleString("zh-CN")}
                {session.revokedAt === undefined ? null : " · 已撤销"}
                {canManage && session.revokedAt === undefined ? (
                  <>
                    {" "}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={revokeSession.isPending || reason.trim() === ""}
                      onClick={() => revokeSession.mutate(session.id)}
                    >
                      撤销会话
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {canManage ? (
        <Input
          label="撤销说明"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="撤销票据或会话时必填"
        />
      ) : null}
      {error === null || error === undefined ? null : (
        <p className="ui-field__error" role="alert">{humanError(error)}</p>
      )}
    </Card>
  );
}
