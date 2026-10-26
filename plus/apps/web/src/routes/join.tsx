import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

export function JoinPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError("请输入活动公开码");
      return;
    }
    setError(null);
    void navigate({ to: "/join/$publicCode", params: { publicCode: trimmed } });
  }

  return (
    <section className="auth-page">
      <div className="auth-card">
        <p className="eyebrow">REGISTRATION · 报名</p>
        <h1 className="auth-title">输入活动公开码</h1>
        <p className="auth-copy">登录后填写报名表；公开码由活动主办方提供。</p>
        <form className="auth-form" onSubmit={submit}>
          <label className="field">
            <span>活动公开码</span>
            <input
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                if (error !== null) setError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="例如 E2E-REG"
            />
          </label>
          {error === null ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" type="submit">
            继续
          </button>
        </form>
      </div>
    </section>
  );
}
