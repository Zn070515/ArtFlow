import type { StudioPublicProfile } from "../../api/studio.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Input.js";
import { Textarea } from "../ui/Textarea.js";

export interface PublicProfileDraft {
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
  readonly announcements: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly publishedAt: string;
  }[];
  readonly faq: readonly {
    readonly question: string;
    readonly answer: string;
  }[];
  readonly links: readonly {
    readonly label: string;
    readonly url: string;
  }[];
  readonly participantsVisible: boolean;
  readonly listedPublicly: boolean;
}

function toLocalInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  return value === "" ? null : new Date(value).toISOString();
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `announcement-${Date.now()}`;
}

export function toDraft(profile: StudioPublicProfile): PublicProfileDraft {
  return {
    tagline: profile.tagline,
    description: profile.description,
    venue: profile.venue,
    startsAt: profile.startsAt === null ? "" : toLocalInput(profile.startsAt),
    endsAt: profile.endsAt === null ? "" : toLocalInput(profile.endsAt),
    organizer: profile.organizer,
    contact: profile.contact,
    announcement: profile.announcement,
    announcements: profile.announcements ?? [],
    faq: profile.faq ?? [],
    links: profile.links ?? [],
    participantsVisible: profile.participantsVisible === true,
    listedPublicly: profile.listedPublicly === true,
  };
}

export function PublicProfileEditor({
  draft,
  onChange,
  disabled,
}: {
  readonly draft: PublicProfileDraft;
  readonly onChange: (next: PublicProfileDraft) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="editor-grid">
      <Input
        label="标语"
        value={draft.tagline}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, tagline: event.target.value })}
        hint="一句话介绍，最多 160 字"
      />
      <Input
        label="地点"
        value={draft.venue}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, venue: event.target.value })}
      />
      <Input
        label="开始时间"
        type="datetime-local"
        value={draft.startsAt}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, startsAt: event.target.value })}
      />
      <Input
        label="结束时间"
        type="datetime-local"
        value={draft.endsAt}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, endsAt: event.target.value })}
      />
      <Input
        label="主办方"
        value={draft.organizer}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, organizer: event.target.value })}
      />
      <Input
        label="联系方式"
        value={draft.contact}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, contact: event.target.value })}
      />
      <Textarea
        label="介绍"
        value={draft.description}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, description: event.target.value })}
        rows={8}
      />
      <Textarea
        label="公告"
        value={draft.announcement}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, announcement: event.target.value })}
        rows={3}
      />
      <label className="inline-check">
        <input
          type="checkbox"
          checked={draft.participantsVisible}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, participantsVisible: event.target.checked })}
        />
        公开参与者目录
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={draft.listedPublicly}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, listedPublicly: event.target.checked })}
        />
        列入公开活动目录
      </label>

      <section className="editor-list" aria-labelledby="profile-announcements-title">
        <h3 className="ui-card__title" id="profile-announcements-title">公告历史</h3>
        {draft.announcements.map((item, index) => (
          <div className="editor-row editor-row--stacked" key={item.id}>
            <Input
              label="公告标题"
              value={item.title}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                announcements: draft.announcements.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, title: event.target.value } : row),
              })}
            />
            <Textarea
              label="公告内容"
              value={item.body}
              disabled={disabled}
              rows={3}
              onChange={(event) => onChange({
                ...draft,
                announcements: draft.announcements.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, body: event.target.value } : row),
              })}
            />
            <Input
              label="发布时间"
              type="datetime-local"
              value={toLocalInput(item.publishedAt)}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                announcements: draft.announcements.map((row, rowIndex) =>
                  rowIndex === index
                    ? { ...row, publishedAt: fromLocalInput(event.target.value) ?? row.publishedAt }
                    : row),
              })}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({
                ...draft,
                announcements: draft.announcements.filter((_, rowIndex) => rowIndex !== index),
              })}
            >
              删除公告
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || draft.announcements.length >= 20}
          onClick={() => onChange({
            ...draft,
            announcements: [
              ...draft.announcements,
              { id: newId(), title: "", body: "", publishedAt: new Date().toISOString() },
            ],
          })}
        >
          添加公告
        </Button>
      </section>

      <section className="editor-list" aria-labelledby="profile-faq-title">
        <h3 className="ui-card__title" id="profile-faq-title">常见问题</h3>
        {draft.faq.map((item, index) => (
          <div className="editor-row editor-row--stacked" key={`faq-${index}`}>
            <Input
              label="问题"
              value={item.question}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                faq: draft.faq.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, question: event.target.value } : row),
              })}
            />
            <Textarea
              label="回答"
              value={item.answer}
              disabled={disabled}
              rows={3}
              onChange={(event) => onChange({
                ...draft,
                faq: draft.faq.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, answer: event.target.value } : row),
              })}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({
                ...draft,
                faq: draft.faq.filter((_, rowIndex) => rowIndex !== index),
              })}
            >
              删除问题
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || draft.faq.length >= 20}
          onClick={() => onChange({ ...draft, faq: [...draft.faq, { question: "", answer: "" }] })}
        >
          添加问题
        </Button>
      </section>

      <section className="editor-list" aria-labelledby="profile-links-title">
        <h3 className="ui-card__title" id="profile-links-title">公开链接</h3>
        {draft.links.map((item, index) => (
          <div className="editor-row" key={`link-${index}`}>
            <Input
              label="链接名称"
              value={item.label}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                links: draft.links.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, label: event.target.value } : row),
              })}
            />
            <Input
              label="链接地址"
              value={item.url}
              disabled={disabled}
              placeholder="https://"
              onChange={(event) => onChange({
                ...draft,
                links: draft.links.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, url: event.target.value } : row),
              })}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({
                ...draft,
                links: draft.links.filter((_, rowIndex) => rowIndex !== index),
              })}
            >
              删除链接
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || draft.links.length >= 10}
          onClick={() => onChange({ ...draft, links: [...draft.links, { label: "", url: "" }] })}
        >
          添加链接
        </Button>
      </section>
    </div>
  );
}
