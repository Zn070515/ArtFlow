import { useEffect, useState, type FormEvent } from "react";

import { submitFeedback } from "../../api/feedback.js";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Select.js";
import { Textarea } from "../ui/Textarea.js";

function storageKey(publicCode: string): string {
  return `artflow.feedback.${publicCode}`;
}

function alreadySubmitted(publicCode: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(publicCode)) === "1";
  } catch {
    return false;
  }
}

function rememberSubmitted(publicCode: string): void {
  try {
    window.localStorage.setItem(storageKey(publicCode), "1");
  } catch {
    // Private mode: the server still accepts a resubmission; the UI may show
    // the form again after a reload.
  }
}

export function FeedbackForm({ publicCode }: { readonly publicCode: string }) {
  const [rating, setRating] = useState("5");
  const [comment, setComment] = useState("");
  const [website, setWebsite] = useState("");
  const [done, setDone] = useState(() => alreadySubmitted(publicCode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDone(alreadySubmitted(publicCode));
  }, [publicCode]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitFeedback(publicCode, Number(rating), comment, website);
      rememberSubmitted(publicCode);
      setDone(true);
    } catch {
      setError("提交失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p className="event-feedback__done" role="status">感谢反馈。</p>;
  }

  return (
    <form className="event-feedback" onSubmit={(event) => void submit(event)}>
      <Select
        label="评分"
        value={rating}
        onChange={(event) => setRating(event.target.value)}
      >
        <option value="5">5 · 非常满意</option>
        <option value="4">4 · 满意</option>
        <option value="3">3 · 一般</option>
        <option value="2">2 · 不满意</option>
        <option value="1">1 · 很不满意</option>
      </Select>
      <Textarea
        label="想说的话（可选）"
        value={comment}
        maxLength={1000}
        rows={3}
        onChange={(event) => setComment(event.target.value)}
      />
      <label className="event-feedback__honeypot" aria-hidden="true">
        网站
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </label>
      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? "正在提交…" : "提交反馈"}
      </Button>
    </form>
  );
}
