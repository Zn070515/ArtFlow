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
}
