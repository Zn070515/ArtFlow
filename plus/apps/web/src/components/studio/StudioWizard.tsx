import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ApiError } from "../../api/client.js";
import {
  createStudioActivity,
  previewPack,
  type ActivityPackSummary,
} from "../../api/studio.js";
import { capabilityLabels } from "../format/labels.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { apiErrorText } from "../ui/apiError.js";
import { summarizeDefinition } from "./definitionSummary.js";
import {
  defaultsFor,
  packCopy,
  questionsForStep,
  WIZARD_STEPS,
  type WizardStep,
} from "./studioWizardData.js";

function SummarySection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="definition-summary-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function StudioWizard({ packs }: { readonly packs: readonly ActivityPackSummary[] }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>("pack");
  const [packId, setPackId] = useState(packs[0]?.identity ?? "");
  const pack = packs.find((candidate) => candidate.identity === packId) ?? packs[0];
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Record<string, boolean>>(
    () => pack === undefined ? {} : defaultsFor(pack),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "新建活动 · Studio";
  }, []);

  useEffect(() => {
    if (pack === undefined) return;
    setAnswers(defaultsFor(pack));
  }, [pack?.identity]);

  const preview = useQuery({
    queryKey: ["pack-preview", pack?.identity, title, answers],
    queryFn: () => {
      if (pack === undefined) return Promise.reject(new Error("no pack"));
      return previewPack(pack.identity, { title: title || packCopy(pack).title, answers });
    },
    enabled: pack !== undefined,
    retry: false,
  });
  const summary = summarizeDefinition(preview.data?.definition, preview.data?.enabledCapabilities ?? []);
  const stepIndex = WIZARD_STEPS.findIndex((item) => item.id === step);
  const stepDef = WIZARD_STEPS[stepIndex] ?? WIZARD_STEPS[0];
  const nextStep = WIZARD_STEPS[stepIndex + 1];
  const canNext = step === "basics" ? title.trim() !== "" : true;
  const previewError = preview.error instanceof ApiError ? preview.error : null;

  async function create(): Promise<void> {
    if (pack === undefined || title.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const activity = await createStudioActivity(crypto.randomUUID(), {
        title: title.trim(),
        packId: pack.identity,
        answers,
      });
      await navigate({ to: "/studio/$activityId", params: { activityId: activity.id } });
    } catch (caught) {
      setError(apiErrorText(caught, "创建失败，请稍后重试。", "标题或能力组合与现有活动冲突，请调整后重试。"));
    } finally {
      setBusy(false);
    }
  }

  if (pack === undefined) {
    return <p className="ui-card__description">没有可用的活动模板。</p>;
  }

  return (
    <section className="studio-wizard">
      <ol className="studio-wizard__steps" aria-label="创建步骤">
        {WIZARD_STEPS.map((item, index) => (
          <li key={item.id} className={item.id === step ? "is-current" : index < stepIndex ? "is-done" : ""}>
            <button type="button" disabled={index > stepIndex} onClick={() => setStep(item.id)}>
              <span>{index + 1}</span>{item.label}
            </button>
          </li>
        ))}
      </ol>
      <div className="studio-wizard__grid">
        <Card className="studio-wizard__main">
          <h2 className="ui-card__title">{stepDef.label}</h2>
          {step === "pack" ? (
            <div className="wizard-pack-grid">
              {packs.map((candidate) => (
                <button
                  type="button"
                  key={candidate.identity}
                  className={candidate.identity === pack.identity ? "wizard-pack is-selected" : "wizard-pack"}
                  onClick={() => setPackId(candidate.identity)}
                >
                  <strong>{packCopy(candidate).title}</strong>
                  <span>{packCopy(candidate).description}</span>
                  <span>已包含：{capabilityLabels(candidate.baselineCapabilities)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {step === "basics" ? (
            <>
              <Input label="活动标题" value={title} onChange={(event) => setTitle(event.target.value)} />
              <p className="ui-card__description">公开码会在创建后生成；创建后可补全公开主页。</p>
            </>
          ) : null}
          {step === "registration" || step === "evaluation" || step === "operations" ? (
            <div className="wizard-questions">
              <p className="ui-card__description">已包含：{capabilityLabels(pack.baselineCapabilities)}</p>
              {questionsForStep(pack, step).map((question) => (
                <label key={question.id} className="pack-question">
                  <input
                    type="checkbox"
                    checked={answers[question.id] ?? question.default}
                    onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.checked }))}
                  />
                  <span>{question.prompt}</span>
                </label>
              ))}
              {questionsForStep(pack, step).length === 0 ? (
                <p className="ui-card__description">这个模板在此步骤没有额外选项。</p>
              ) : null}
            </div>
          ) : null}
          {step === "review" ? (
            <div className="definition-summary">
              <p className="ui-card__description">
                已启用：{capabilityLabels(preview.data?.enabledCapabilities ?? [])}
              </p>
              {previewError === null ? null : (
                <div className="ui-field__error" role="alert">
                  <p>{previewError.message}</p>
                  {Array.isArray(previewError.details) ? (
                    <ul>
                      {(previewError.details as { code: string; message: string; path: string }[]).map((issue) => (
                        <li key={`${issue.path}-${issue.code}`}>{issue.path}: {issue.message}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
              <SummarySection title="报名字段" items={summary.registration} />
              <SummarySection title="回合与评委" items={summary.rounds} />
              <SummarySection title="评分方式" items={summary.scoring} />
              <SummarySection title="材料限制" items={summary.materials} />
              <SummarySection title="发布阶段" items={summary.publishing} />
              <SummarySection title="投票" items={summary.voting} />
            </div>
          ) : null}
          {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
          <div className="studio-toolbar">
            <Button
              variant="secondary"
              disabled={stepIndex === 0}
              onClick={() => setStep(WIZARD_STEPS[stepIndex - 1]?.id ?? "pack")}
            >
              上一步
            </Button>
            {nextStep === undefined ? (
              <Button
                variant="primary"
                disabled={busy || previewError !== null || preview.isPending || title.trim() === ""}
                onClick={() => void create()}
              >
                {busy ? "正在创建…" : "创建活动"}
              </Button>
            ) : (
              <Button variant="primary" disabled={!canNext} onClick={() => setStep(nextStep.id)}>
                下一步
              </Button>
            )}
          </div>
        </Card>
        <Card className="studio-wizard__rail">
          <h2 className="ui-card__title">将创建</h2>
          {preview.isPending ? <p className="ui-card__description">正在生成预览…</p> : null}
          {preview.data === undefined ? null : (
            <>
              <p className="ui-card__description">
                已启用：{capabilityLabels(preview.data.enabledCapabilities)}
              </p>
              <div className="definition-summary">
                <SummarySection title="报名字段" items={summary.registration} />
                <SummarySection title="回合与评委" items={summary.rounds} />
                <SummarySection title="评分方式" items={summary.scoring} />
                <SummarySection title="材料限制" items={summary.materials} />
                <SummarySection title="发布阶段" items={summary.publishing} />
                <SummarySection title="投票" items={summary.voting} />
              </div>
              <details className="definition-raw">
                <summary>高级：原始 JSON</summary>
                <pre className="preview-json">{JSON.stringify(preview.data.definition, null, 2)}</pre>
              </details>
            </>
          )}
        </Card>
      </div>
    </section>
  );
}
