import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

export function CodeEntry() {
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
    void navigate({
      to: "/results/$publicCode",
      params: { publicCode: trimmed },
    });
  }

  return (
    <form className="code-form" onSubmit={submit} noValidate>
      <label className="sr-only" htmlFor="public-code">
        活动公开码
      </label>
      <div className="code-field">
        <input
          id="public-code"
          name="publicCode"
          autoComplete="off"
          spellCheck={false}
          placeholder="输入活动公开码"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            if (error !== null) setError(null);
          }}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : "public-code-error"}
        />
        <button type="submit">查看赛果</button>
      </div>
      {error === null ? null : (
        <p className="code-error" id="public-code-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
