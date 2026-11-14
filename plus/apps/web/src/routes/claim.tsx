import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { claimInvite, previewInvite, type InvitePreview } from "../api/auth.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { Input } from "../components/ui/Input.js";
import { apiErrorText } from "../components/ui/apiError.js";

export function ClaimPage() {
  return <ClaimContent />;
}

function ClaimContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : "";
    // The fragment never reaches the server or an access log; remove it from
    // the address bar and history as soon as it has been read.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (raw === "") {
      setToken("");
      return;
    }
    setToken(raw);
    void previewInvite(raw)
      .then(setPreview)
      .catch((cause) => {
        setError(apiErrorText(cause, "邀请链接无效。", "邀请已失效或已被使用。"));
      });
  }, []);

  async function claim(): Promise<void> {
    if (token === null || token === "") return;
    if (password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await claimInvite(token, password);
      queryClient.setQueryData(["me"], session);
      queryClient.removeQueries({
        predicate: (candidate) => candidate.queryKey[0] !== "me",
      });
      await navigate({ to: "/workspace" });
    } catch (cause) {
      setError(apiErrorText(cause, "认领失败，请稍后重试。", "邀请已失效或已被使用。"));
    } finally {
      setBusy(false);
    }
  }

  if (token === "") {
    return (
      <EmptyState
        title="邀请链接无效"
        description="链接不完整或已过期，请联系管理员重新生成。"
      />
    );
  }
  if (token === null) {
    return <p className="auth-loading">正在校验邀请…</p>;
  }
  if (preview === null) {
    return error === null ? (
      <p className="auth-loading">正在校验邀请…</p>
    ) : (
      <ErrorState description={error} />
    );
  }

  return (
    <section className="auth-page">
      <Card>
        <h1 className="ui-page-title">设置登录密码</h1>
        <p className="ui-page-meta">
          账号 {preview.username} · 链接有效期至 {preview.expiresAt.slice(0, 10)}
        </p>
        <Input
          label="新密码"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="至少 12 位；不要使用常见密码或用户名本身"
          autoFocus
        />
        <Input
          label="再次输入密码"
          type="password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
        <Button
          variant="primary"
          loading={busy}
          disabled={password.length < 12 || confirmation.length < 12}
          onClick={() => { void claim(); }}
        >
          设置密码并登录
        </Button>
      </Card>
    </section>
  );
}
