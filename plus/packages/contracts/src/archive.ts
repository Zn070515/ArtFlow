import { Type, type Static } from "@sinclair/typebox";

const RevisionSchema = Type.Integer({ minimum: 1 });
const NoteSchema = Type.String({ minLength: 1, maxLength: 2000 });

export const CloseActivityBodySchema = Type.Object(
  { expectedRevision: RevisionSchema },
  { additionalProperties: false },
);

export const RenameActivityBodySchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    expectedRevision: RevisionSchema,
  },
  { additionalProperties: false },
);

export const ArchiveActivityBodySchema = Type.Object(
  { expectedRevision: RevisionSchema, note: NoteSchema },
  { additionalProperties: false },
);

export const UnarchiveActivityBodySchema = Type.Object(
  { expectedRevision: RevisionSchema, note: NoteSchema },
  { additionalProperties: false },
);

export const ArchiveFileQuerySchema = Type.Object(
  { version: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false },
);

export type CloseActivityBody = Static<typeof CloseActivityBodySchema>;
export type RenameActivityBody = Static<typeof RenameActivityBodySchema>;
export type ArchiveActivityBody = Static<typeof ArchiveActivityBodySchema>;
export type UnarchiveActivityBody = Static<typeof UnarchiveActivityBodySchema>;
export type ArchiveFileQuery = Static<typeof ArchiveFileQuerySchema>;
