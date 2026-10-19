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
  result: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface OutboxRow {
  id: Generated<number>;
  event_type: string;
  payload: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
  published_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface Database {
  activity: ActivityRow;
  command_receipt: CommandReceiptRow;
  outbox: OutboxRow;
}
