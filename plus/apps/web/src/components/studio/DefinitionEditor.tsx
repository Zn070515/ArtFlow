import { useEffect, useState } from "react";

import { ApiError } from "../../api/client.js";
import { compileStudioDefinition, type StudioState } from "../../api/studio.js";

function defaultText(state: StudioState): string {
  return JSON.stringify(
    state.draft?.package ?? {
      schemaVersion: 1,
      manifest: { key: state.activity.id, title: state.activity.title },
      capabilities: {},
      bindings: [],
    },
    null,
    2,
  );
}

export function DefinitionEditor({
  state,
  onChanged,
}: {
  readonly state: StudioState;
  readonly onChanged: () => void;
}) {
  const [text, setText] = useState(() => defaultText(state));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<unknown>(null);

  useEffect(() => {
    setText(defaultText(state));
  }, [state.activity.id, state.draft?.revision]);

  async function compile(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    setDetails(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("JSON 格式错误，请先修正。");
      setBusy(false);
      return;
    }
    try {
      const result = await compileStudioDefinition(
        state.activity.id,
        crypto.randomUUID(),
        parsed,
        state.draft?.revision,
      );
      setMessage(`编译成功 · ${result.contentHash.slice(0, 12)}…`);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setDetails(caught.details ?? null);
      } else {
        setError("编译失败，请稍后重试。");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-card studio-editor">
      <p className="eyebrow">DEFINITION · 定义</p>
      <div className="studio-card-head">
        <h2>Definition Package</h2>
        <span className="state-copy">
          draft revision {state.draft?.revision ?? "—"}
          {state.compiled === null ? "" : ` · compiled ${state.compiled.contentHash.slice(0, 12)}…`}
        </span>
      </div>
      <textarea
        className="editor-textarea"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Definition Package JSON"
      />
      <div className="studio-toolbar">
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            try {
              setText(JSON.stringify(JSON.parse(text), null, 2));
              setError(null);
            } catch {
              setError("JSON 格式错误，无法格式化。");
            }
          }}
        >
          格式化
        </button>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void compile()}>
          {busy ? "正在编译…" : "编译定义"}
        </button>
      </div>
      {message === null ? null : <p className="form-success">{message}</p>}
      {error === null ? null : (
        <div className="studio-issue" role="alert">
          <p>{error}</p>
          {details === null ? null : <pre>{JSON.stringify(details, null, 2)}</pre>}
        </div>
      )}
    </section>
  );
}
