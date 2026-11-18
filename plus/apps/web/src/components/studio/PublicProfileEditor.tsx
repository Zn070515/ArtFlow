import type { StudioPublicProfile } from "../../api/studio.js";
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
    </div>
  );
}
