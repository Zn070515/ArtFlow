import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .alterTable("attendance_fact")
      .addColumn("source", "varchar(20)", (column) => column.notNull().defaultTo("direct"))
      .addColumn("source_reference", "varchar(200)")
      .execute();
    await sql`
      alter table attendance_fact
      add constraint attendance_fact_source_check
      check (source in ('direct', 'manual_paper'))
    `.execute(db);
    // A paper entry must carry its paper reference; a direct entry must not.
    await sql`
      alter table attendance_fact
      add constraint attendance_fact_source_reference_check
      check (
        (source = 'direct' and source_reference is null)
        or (source = 'manual_paper' and length(btrim(source_reference)) between 1 and 200)
      )
    `.execute(db);
  },
  async down(db: Kysely<Database>): Promise<void> {
    await sql`
      alter table attendance_fact
      drop constraint if exists attendance_fact_source_reference_check
    `.execute(db);
    await sql`
      alter table attendance_fact
      drop constraint if exists attendance_fact_source_check
    `.execute(db);
    await db.schema
      .alterTable("attendance_fact")
      .dropColumn("source_reference")
      .dropColumn("source")
      .execute();
  },
};
