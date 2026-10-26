import { useState } from "react";

import { ApiError } from "../../api/client.js";
import { releaseStudioDefinition, type StudioState } from "../../api/studio.js";

export function ReleasePanel({
  state,
  onChanged,
}: {
  readonly state: StudioState;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRelease =
    state.activity.status === "active" && state.compiled !== null && state.draft !== null;

  async function release(): Promise<void> {
    if (state.draft === null) return;
    setBusy(true);
    setError(null);
    try {
      await releaseStudioDefinition(
        state.activity.id,
        crypto.randomUUID(),
        state.draft.revision,
      );
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "发布失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-card">
      <p className="eyebrow">RELEASE · 发布</p>
      <h2>定义发布</h2>
      {state.releases.length === 0 ? (
        <p className="state-copy">还没有发布版本。</p>
      ) : (
        <ul className="release-list">
          {state.releases.map((release) => (
            <li key={release.version}>
              <span>v{release.version}</span>
              <span>{release.releasedAt.slice(0, 10)}</span>
              {release.active ? <span className="active-badge">ACTIVE</span> : null}
            </li>
          ))}
        </ul>
      )}
      <button
        className="primary-button"
        type="button"
        disabled={!canRelease || busy}
        onClick={() => void release()}
      >
        {busy ? "正在发布…" : "发布当前编译"}
      </button>
      {state.activity.status === "draft" ? <p className="state-copy">先激活活动。</p> : null}
      {state.compiled === null ? <p className="state-copy">先编译当前 draft。</p> : null}
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
