import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("incident")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("mode", "varchar(20)", (column) => column.notNull())
      .addColumn("severity", "varchar(20)", (column) => column.notNull())
      .addColumn("category", "varchar(20)", (column) => column.notNull())
      .addColumn("status", "varchar(20)", (column) => column.notNull())
      .addColumn("title", "varchar(200)", (column) => column.notNull())
      .addColumn("detail", "varchar(2000)", (column) => column.notNull().defaultTo(""))
      .addColumn("location", "varchar(200)", (column) => column.notNull().defaultTo(""))
      .addColumn("related_type", "varchar(30)")
      .addColumn("related_id", "varchar(100)")
      .addColumn("assignee_id", "varchar(100)")
      .addColumn("resolution", "varchar(2000)", (column) => column.notNull().defaultTo(""))
      .addColumn("opened_by", "varchar(100)", (column) => column.notNull())
      .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addCheckConstraint("incident_mode_check", sql`mode in ('test', 'rehearsal', 'formal')`)
      .addCheckConstraint(
        "incident_severity_check",
        sql`severity in ('low', 'medium', 'high', 'critical')`,
      )
      .addCheckConstraint(
        "incident_category_check",
        sql`category in ('participant', 'judge', 'stage', 'technical', 'safety', 'other')`,
      )
      .addCheckConstraint(
        "incident_status_check",
        sql`status in ('open', 'acknowledged', 'resolved')`,
      )
      .addCheckConstraint(
        "incident_related_type_check",
        sql`related_type is null or related_type in ('schedule_entry', 'performance', 'round', 'registration')`,
      )
      .addCheckConstraint(
        "incident_related_pair_check",
        sql`(related_type is null) = (related_id is null)`,
      )
      .execute();
    await db.schema
      .createIndex("incident_activity_mode_status_idx")
      .on("incident")
      .columns(["activity_id", "mode", "status", "created_at"])
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("incident").ifExists().execute();
  },
};
