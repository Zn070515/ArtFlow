import { useState, type SubmitEvent } from "react";

import { forgotPassword } from "../api/auth.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";

export function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      await forgotPassword(identifier.trim());
    } finally {
      setBusy(false);
      // The API intentionally never reveals whether the account exists.
      setSent(true);
    }
  }

  return (
    <section className="auth-page">
      <div className="auth-card">
        <p className="eyebrow">ARTFLOW · ACCOUNT</p>
        <h1 className="auth-title">找回密码</h1>
        {sent ? (
          <p className="auth-copy">
            如果该账号存在且已登记邮箱，重置链接已发送。链接 30 分钟内有效，只能使用一次。
          </p>
        ) : (
          <>
            <p className="auth-copy">输入用户名或已登记的邮箱，我们会发送重置链接。</p>
            <form className="auth-form" onSubmit={(event) => void submit(event)}>
              <Input
                label="用户名或邮箱"
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                maxLength={320}
                required
              />
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? "请稍候…" : "发送重置链接"}
              </Button>
            </form>
          </>
        )}
        <a className="auth-switch" href="/login">返回登录</a>
      </div>
    </section>
  );
}
