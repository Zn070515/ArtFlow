import { useEffect, useState } from "react";

import { ApiError } from "../../api/client.js";
import { compileStudioDefinition, type StudioState } from "../../api/studio.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { apiErrorText } from "../ui/apiError.js";
import { CapabilityEditor } from "./editors/CapabilityEditor.js";
import { patchCapabilityPayload, readCapabilityPayload } from "./definitionPackage.js";

type EditorTab = "structured" | "json";

function defaultPackage(state: StudioState): unknown {
  return state.draft?.package ?? {
    schemaVersion: 1,
    manifest: { key: state.activity.id, title: state.activity.title },
    capabilities: {},
    bindings: [],
  };
}

function defaultText(state: StudioState): string {
  return JSON.stringify(defaultPackage(state), null, 2);
}

export function DefinitionEditor({
  state,
  onChanged,
}: {
  readonly state: StudioState;
  readonly onChanged: () => void;
}) {
  const [tab, setTab] = useState<EditorTab>("structured");
  const [pkg, setPkg] = useState<unknown>(() => defaultPackage(state));
  const [text, setText] = useState(() => defaultText(state));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<unknown>(null);

  useEffect(() => {
    const next = defaultPackage(state);
    setPkg(next);
    setText(JSON.stringify(next, null, 2));
    setJsonError(null);
  }, [state.activity.id, state.draft?.revision]);

  function updatePackage(next: unknown): void {
    setPkg(next);
    setText(JSON.stringify(next, null, 2));
    setJsonError(null);
  }

  function updateText(next: string): void {
    setText(next);
    try {
      setPkg(JSON.parse(next));
      setJsonError(null);
    } catch {
      setJsonError("JSON 格式错误，结构化编辑暂不更新。");
    }
  }

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
      setError(apiErrorText(caught, "编译失败，请稍后重试。", "草稿已被更新，请刷新后重新编译。"));
      setDetails(caught instanceof ApiError ? caught.details ?? null : null);
    } finally {
      setBusy(false);
    }
  }

  const enabled = state.activity.enabledCapabilities;

  return (
    <Card className="studio-editor">
      <div className="studio-card-head">
        <h2 className="ui-card__title">Definition Package</h2>
        <span className="ui-card__description">
          draft revision {state.draft?.revision ?? "—"}
          {state.compiled === null ? "" : ` · compiled ${state.compiled.contentHash.slice(0, 12)}…`}
        </span>
      </div>
      <div className="studio-tabs" role="tablist" aria-label="定义编辑模式">
        <button
          type="button"
          role="tab"
          className="studio-tab"
          aria-selected={tab === "structured"}
          onClick={() => setTab("structured")}
        >
          结构化
        </button>
        <button
          type="button"
          role="tab"
          className="studio-tab"
          aria-selected={tab === "json"}
          onClick={() => setTab("json")}
        >
          高级 JSON
        </button>
      </div>
      {tab === "structured" ? (
        <div role="tabpanel" aria-label="结构化编辑" className="studio-structured">
          {enabled.length === 0 ? (
            <p className="ui-card__description">该活动还没有启用能力，请先用引导模式选择能力。</p>
          ) : (
            enabled.map((capability) => (
              <CapabilityEditor
                key={capability}
                capability={capability}
                payload={readCapabilityPayload(pkg, capability)}
                onChange={(payload) => updatePackage(patchCapabilityPayload(pkg, capability, payload))}
              />
            ))
          )}
        </div>
      ) : (
        <div role="tabpanel" aria-label="高级 JSON 编辑">
          <textarea
            className="editor-textarea"
            spellCheck={false}
            value={text}
            onChange={(event) => updateText(event.target.value)}
            aria-label="Definition Package JSON"
          />
          {jsonError === null ? null : (
            <p className="ui-field__error" role="alert">{jsonError}</p>
          )}
          <div className="studio-toolbar">
            <Button
              variant="secondary"
              onClick={() => {
                try {
                  const formatted = JSON.stringify(JSON.parse(text), null, 2);
                  setText(formatted);
                  setJsonError(null);
                } catch {
                  setJsonError("JSON 格式错误，无法格式化。");
                }
              }}
            >
              格式化
            </Button>
          </div>
        </div>
      )}
      <div className="studio-toolbar">
        <Button variant="primary" disabled={busy} onClick={() => void compile()}>
          {busy ? "正在编译…" : "编译定义"}
        </Button>
      </div>
      {message === null ? null : <p className="form-success">{message}</p>}
      {error === null ? null : (
        <div className="studio-issue" role="alert">
          <p>{error}</p>
          {details === null ? null : <pre>{JSON.stringify(details, null, 2)}</pre>}
        </div>
      )}
    </Card>
  );
}
