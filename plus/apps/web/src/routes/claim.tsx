import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError } from "../api/client.js";
import { consumeParticipantClaim } from "../api/participantClaim.js";
import { useSession } from "../auth/SessionProvider.js";

function readClaimToken(): string | null {
  if (typeof window === "undefined" || window.location.hash.length <= 1) return null;
  try {
    const token = decodeURIComponent(window.location.hash.slice(1)).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function displayError(error: unknown): string {
  if (error instanceof ApiError && error.code === "INVALID_PARTICIPANT_CLAIM") {
    return "认领链接无效或已过期，请联系活动工作人员重新生成。";
  }
  if (error instanceof ApiError && error.code === "USERNAME_TAKEN") {
    return "这个用户名已被占用，请换一个。";
  }
  return error instanceof Error ? error.message : "网络或服务暂时不可用，请稍后重试。";
}

export async function copyClaimLink(link: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      // Fall through to the selection-based fallback when browser permissions deny Clipboard API access.
    }
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    throw new Error("复制失败，请手动复制链接。");
  }

  const textarea = document.createElement("textarea");
  textarea.value = link;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("复制失败，请手动复制链接。");
    return true;
  } finally {
    textarea.remove();
  }
}

export function ClaimPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, isLoading } = useSession();
  const [token] = useState(readClaimToken);
  const [manualToken, setManualToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(
    token === null ? "认领链接无效或已过期，请联系活动工作人员重新生成。" : null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash === "") return;
    window.history.replaceState(window.history.state, document.title, `${window.location.pathname}${window.location.search}`);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const submittedToken = token ?? manualToken.trim();
    if (submittedToken.length === 0) {
      setError("认领链接无效或已过期，请联系活动工作人员重新生成。");
      return;
    }
    if (session === null && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const result = await consumeParticipantClaim(
        submittedToken,
        crypto.randomUUID(),
        session === null ? { username: username.trim(), password } : undefined,
      );
      await queryClient.refetchQueries({ queryKey: ["me"], type: "active" });
      await navigate({ to: "/join/$publicCode", params: { publicCode: result.publicCode } });
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <p className="auth-loading">正在验证登录…</p>;

  return (
    <section className="auth-page">
      <div className="auth-card claim-card">
        <p className="eyebrow">PARTICIPANT · 账号认领</p>
        <h1 className="auth-title">接收活动报名</h1>
        <p className="auth-copy">
          {session === null
            ? "这是一次性认领链接。创建参与者账号后，系统会把已导入的报名记录交给你。"
            : "当前登录账号将接收这条已导入的报名记录。"}
        </p>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {token === null ? (
            <label className="field">
              <span>认领链接 token</span>
              <input
                autoComplete="off"
                spellCheck={false}
                value={manualToken}
                onChange={(event) => {
                  setManualToken(event.target.value);
                  setError(null);
                }}
                required
              />
            </label>
          ) : null}
          {session === null ? (
            <>
              <label className="field">
                <span>用户名</span>
                <input
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  minLength={3}
                  maxLength={64}
                  pattern="[A-Za-z0-9_.-]+"
                  required
                />
              </label>
              <label className="field">
                <span>密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  maxLength={128}
                  required
                />
              </label>
              <label className="field">
                <span>确认密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  minLength={8}
                  maxLength={128}
                  required
                />
              </label>
            </>
          ) : null}
          {error === null ? null : <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "正在接收…" : session === null ? "创建账号并继续" : "接收报名"}
          </button>
        </form>
      </div>
    </section>
  );
}
