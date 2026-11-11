import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema
        .createTable("task_item")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) =>
          column.notNull().references("activity.id").onDelete("cascade"),
        )
        .addColumn("definition_version", "integer", (column) => column.notNull())
        .addColumn("template_key", "varchar(100)", (column) => column.notNull())
        .addColumn("title", "varchar(200)", (column) => column.notNull())
        .addColumn("source_capability", "varchar(100)", (column) => column.notNull())
        .addColumn("source_key", "varchar(200)", (column) => column.notNull())
        .addColumn("required", "boolean", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("pending"))
        .addColumn("assignee_actor_id", "varchar(100)")
        .addColumn("due_at", "timestamptz")
        .addColumn("blocked_reason", "text")
        .addColumn("completion_reason", "text")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addUniqueConstraint("task_item_activity_version_template_key", [
          "activity_id",
          "definition_version",
          "template_key",
        ])
        .addCheckConstraint(
          "task_item_definition_version_check",
          sql`definition_version > 0`,
        )
        .addCheckConstraint(
          "task_item_status_check",
          sql`status in ('pending', 'in_progress', 'blocked', 'done')`,
        )
        .addCheckConstraint(
          "task_item_fields_check",
          sql`length(btrim(template_key)) > 0 and length(btrim(title)) > 0 and length(btrim(source_capability)) > 0 and length(btrim(source_key)) > 0`,
        )
        .execute();
      await db.schema
        .createIndex("task_item_activity_version_status_idx")
        .on("task_item")
        .columns(["activity_id", "definition_version", "status"])
        .execute();
      await db.schema
        .createIndex("task_item_due_at_idx")
        .on("task_item")
        .columns(["activity_id", "definition_version", "due_at"])
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("task_item").ifExists().execute();
    },
  }
