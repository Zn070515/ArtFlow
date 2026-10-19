import type { ColumnType, Generated } from "kysely";

export interface ActivityRow {
  id: string;
  title: string;
  status: string;
  revision: number;
  // pg returns jsonb as an object, but a parameter must be sent as JSON text.
  enabled_capabilities: ColumnType<string[] | string, string, string>;
  active_definition_version: number;
}

export interface CommandReceiptRow {
  command_id: string;
  activity_id: string;
  capability: string;
  command_type: string;
  payload_hash: string;
  scope: string | null;
  actor_id: string | null;
  actor_type: string | null;
  result: ColumnType<unknown | null, string | null, string | null>;
  http_status: number | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface OutboxRow {
  id: Generated<string>;
  event_id: string;
  event_type: string;
  occurred_at: ColumnType<Date, Date | string | undefined, never>;
  activity_id: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  capability: string | null;
  revision: number | null;
  mode: string | null;
  scope: string | null;
  actor_id: string | null;
  actor_type: string | null;
  payload: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  published_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  attempts: number;
  last_error: string | null;
  dead_lettered_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface DefinitionDraftRow {
  activity_id: string;
  revision: number;
  package: ColumnType<unknown, string, string>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface DefinitionCompiledRow {
  activity_id: string;
  draft_revision: number;
  content_hash: string;
  capabilities: ColumnType<unknown, string, string>;
  compiled_at: ColumnType<Date, Date | undefined, never>;
}

export interface DefinitionReleaseRow {
  activity_id: string;
  version: number;
  content_hash: string;
  capabilities: ColumnType<unknown, string, string>;
  execution_policy: ColumnType<unknown, string, string>;
  capability_versions: ColumnType<unknown, string, string>;
  bindings: ColumnType<unknown, string, string>;
  released_at: ColumnType<Date, Date | string, never>;
  source_draft_revision: number;
}

export interface ExecutionSessionRow {
  id: string;
  activity_id: string;
  definition_version: number;
  content_hash: string;
  scope: string;
  mode: string;
  status: string;
  revision: number;
  opened_at: ColumnType<Date, Date | string, Date | string>;
  closed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface ExecutionProjectionRow {
  activity_id: string;
  mode: string;
  last_sequence: ColumnType<string, string | number, string | number>;
  state: ColumnType<unknown, string, string>;
  status: string;
  blocked_sequence: ColumnType<string | null, string | number | null, string | number | null>;
  blocked_reason: string | null;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface AuditEntryRow {
  id: Generated<string>;
  command_id: string;
  activity_id: string | null;
  capability: string;
  command_type: string;
  actor_id: string;
  actor_type: string;
  detail: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface LocalAccountRow {
  username: string;
  password_digest: string;
  actor_id: string;
  actor_type: string;
  roles: ColumnType<string[] | string, string, string>;
  permissions: ColumnType<string[] | string, string, string>;
  auth_context: string | null;
  active: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface LocalSessionRow {
  token: string;
  actor_id: string;
  actor_type: string;
  roles: ColumnType<string[] | string, string, string>;
  permissions: ColumnType<string[] | string, string, string>;
  auth_context: string | null;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface RegistrationRow {
  id: string;
  activity_id: string;
  participant_id: string;
  questionnaire_version: string;
  questionnaire_hash: string;
  status: string;
  answers: ColumnType<unknown, string, string>;
  revision: number;
  review_note: string | null;
  reviewed_by: string | null;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface RosterRow {
  activity_id: string;
  status: string;
  approved_count: number | null;
  revision: number;
  finalized_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface MaterialRow {
  id: string;
  activity_id: string;
  registration_id: string;
  question_key: string;
  storage_key: string;
  original_name: string;
  content_type: string;
  byte_length: number;
  owner_actor_id: string;
  status: string;
  review_note: string;
  reviewed_by: string | null;
  reviewed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  revision: number;
  current: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface Database {
  activity: ActivityRow;
  command_receipt: CommandReceiptRow;
  outbox: OutboxRow;
  definition_draft: DefinitionDraftRow;
  definition_compiled: DefinitionCompiledRow;
  definition_release: DefinitionReleaseRow;
  execution_session: ExecutionSessionRow;
  execution_projection: ExecutionProjectionRow;
  audit_entry: AuditEntryRow;
  local_account: LocalAccountRow;
  local_session: LocalSessionRow;
  registration: RegistrationRow;
  roster: RosterRow;
  material: MaterialRow;
}
