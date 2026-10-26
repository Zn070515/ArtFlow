import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError } from "../api/client.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";

type Mode = "login" | "register";

function safeNext(next: string | undefined): string | null {
  if (next === undefined || !next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

export function LoginPage() {
  const { next } = useSearch({ from: "/login" });
  const { session, login, register } = useSession();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const target = safeNext(next);

  useEffect(() => {
    if (session === null) return;
    void navigate({ to: target ?? (hasOpsAccess(session) ? "/ops" : "/join") });
  }, [session, target, navigate]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const session = mode === "login" ? await login(username, password) : await register(username, password);
      await navigate({ to: target ?? (hasOpsAccess(session) ? "/ops" : "/join") });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(
          caught.code === "USERNAME_TAKEN"
            ? "这个用户名已被占用，请换一个"
            : caught.status === 401
              ? "用户名或密码错误"
              : caught.message,
        );
      } else {
        setError("网络或服务暂时不可用，请稍后重试");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-page">
      <div className="auth-card">
        <p className="eyebrow">ARTFLOW · ACCOUNT</p>
        <h1 className="auth-title">{mode === "login" ? "登录" : "创建参与者账号"}</h1>
        <p className="auth-copy">
          {mode === "login" ? "登录后报名、查看审核状态。" : "账号只用于本次活动报名；姓名等信息在报名表中填写。"}
        </p>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>用户名</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={3}
              maxLength={64}
              required
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          {mode === "register" ? (
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
          ) : null}
          {error === null ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "创建账号"}
          </button>
        </form>
        <button
          className="auth-switch"
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "没有账号？创建一个" : "已有账号？去登录"}
        </button>
      </div>
    </section>
  );
}
