import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      // --- releases freeze execution semantics -----------------------------
      await sql`alter table definition_release add column execution_policy jsonb`.execute(db);
      await sql`alter table definition_release add column capability_versions jsonb`.execute(
        db,
      );
      await sql`alter table definition_release add column bindings jsonb`.execute(db);
      await sql`
        update definition_release
           set execution_policy = coalesce(
                 execution_policy,
                 '{"declaredScopes":[],"conflicts":{},"runtimeContractVersion":1}'::jsonb
               ),
               capability_versions = coalesce(capability_versions, '{}'::jsonb),
               bindings = coalesce(bindings, '[]'::jsonb)
         where execution_policy is null
            or capability_versions is null
            or bindings is null
      `.execute(db);
      await sql`
        alter table definition_release
          alter column execution_policy set not null,
          alter column capability_versions set not null,
          alter column bindings set not null
      `.execute(db);

      // --- projections can be explicitly blocked ---------------------------
      await sql`
        alter table execution_projection
          add column status varchar(20) not null default 'running',
          add column blocked_sequence bigint,
          add column blocked_reason text
      `.execute(db);
      await sql`
        alter table execution_projection
          add constraint execution_projection_status_check
          check (status in ('running', 'blocked'))
      `.execute(db);

      // --- actor on the command/event log ----------------------------------
      await sql`alter table command_receipt add column actor_id varchar(100)`.execute(db);
      await sql`alter table command_receipt add column actor_type varchar(20)`.execute(db);
      await sql`alter table outbox add column actor_id varchar(100)`.execute(db);
      await sql`alter table outbox add column actor_type varchar(20)`.execute(db);

      // --- audit is a standard by-product of an accepted command -----------
      await db.schema
        .createTable("audit_entry")
        .addColumn("id", "bigserial", (column) => column.primaryKey())
        .addColumn("command_id", "varchar(100)", (column) => column.notNull())
        .addColumn("activity_id", "varchar(100)")
        .addColumn("capability", "varchar(100)", (column) => column.notNull())
        .addColumn("command_type", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("actor_type", "varchar(20)", (column) => column.notNull())
        .addColumn("detail", "jsonb", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();
      await sql`
        create index audit_entry_activity_idx on audit_entry(activity_id, id)
      `.execute(db);
      await sql`
        create index audit_entry_command_idx on audit_entry(command_id)
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("audit_entry").ifExists().execute();
      await sql`
        alter table outbox
          drop column if exists actor_id,
          drop column if exists actor_type
      `.execute(db);
      await sql`
        alter table command_receipt
          drop column if exists actor_id,
          drop column if exists actor_type
      `.execute(db);
      await sql`
        alter table execution_projection
          drop constraint if exists execution_projection_status_check
      `.execute(db);
      await sql`
        alter table execution_projection
          drop column if exists status,
          drop column if exists blocked_sequence,
          drop column if exists blocked_reason
      `.execute(db);
      await sql`
        alter table definition_release
          drop column if exists execution_policy,
          drop column if exists capability_versions,
          drop column if exists bindings
      `.execute(db);
    },
  }
