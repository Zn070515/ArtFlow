import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Input } from "../components/ui/Input.js";

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
    <section className="join-page">
      <header className="console-page-header">
        <h1 className="ui-page-title">输入活动公开码</h1>
        <p className="ui-page-meta">登录后填写报名表；公开码由活动主办方提供。</p>
      </header>
      <Card className="join-code-card">
        <h2 className="ui-card__title">进入报名表</h2>
        <form className="auth-form" onSubmit={submit}>
          <Input
            label="活动公开码"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              if (error !== null) setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="例如 E2E-REG"
          />
          {error === null ? null : (
            <p className="ui-field__error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit">
            继续
          </Button>
        </form>
      </Card>
    </section>
  );
}
