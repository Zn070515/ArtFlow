import { useEffect, useState, type SubmitEvent } from "react";

import { resetPassword } from "../api/auth.js";
import { ApiError } from "../api/client.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";

function readToken(): string {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash !== "") {
    // The token is a credential; remove it from the address bar immediately.
    window.history.replaceState(null, "", window.location.pathname);
  }
  return hash;
}

export function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setToken(readToken());
  }, []);

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (token === "") {
      setError("重置链接无效，请重新申请。");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "网络或服务暂时不可用，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-page">
      <div className="auth-card">
        <p className="eyebrow">ARTFLOW · ACCOUNT</p>
        <h1 className="auth-title">设置新密码</h1>
        {done ? (
          <>
            <p className="auth-copy">密码已更新，所有旧会话已失效。</p>
            <a className="auth-switch" href="/login">去登录</a>
          </>
        ) : (
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <Input
              label="新密码"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={12}
              maxLength={128}
              required
            />
            <Input
              label="确认新密码"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              minLength={12}
              maxLength={128}
              required
            />
            <p className="ui-card__description">密码至少 12 位，避免使用常见口令。</p>
            {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "请稍候…" : "更新密码"}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
