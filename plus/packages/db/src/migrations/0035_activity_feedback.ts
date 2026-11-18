import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable("activity_feedback")
      .addColumn("id", "varchar(100)", (column) => column.primaryKey())
      .addColumn("activity_id", "varchar(100)", (column) =>
        column.notNull().references("activity.id").onDelete("cascade"),
      )
      .addColumn("rating", "integer", (column) => column.notNull())
      .addColumn("comment", "text", (column) => column.notNull().defaultTo(""))
      .addColumn("source", "varchar(40)", (column) => column.notNull().defaultTo("public"))
      .addColumn("submitted_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addCheckConstraint("activity_feedback_rating_check", sql`rating between 1 and 5`)
      .addCheckConstraint("activity_feedback_comment_check", sql`char_length(comment) <= 1000`)
      .execute();
    await db.schema
      .createIndex("activity_feedback_activity_submitted_idx")
      .on("activity_feedback")
      .columns(["activity_id", "submitted_at"])
      .execute();
  },

  async down(db: Kysely<Database>): Promise<void> {
    await db.schema.dropTable("activity_feedback").ifExists().execute();
  },
};
