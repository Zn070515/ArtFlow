import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await sql`
        alter table score_correction
          drop constraint score_correction_state_check,
          add constraint score_correction_state_check
            check (state in ('open', 'revised', 'closed', 'recalculated', 'cancelled'))
      `.execute(db);
      await db.schema.alterTable("podium_candidate")
        .addColumn("source_score_versions", "jsonb", (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
        .execute();
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("podium_candidate").dropColumn("source_score_versions").execute();
      await sql`update score_correction set state = 'closed' where state = 'recalculated'`.execute(db);
      await sql`
        alter table score_correction
          drop constraint score_correction_state_check,
          add constraint score_correction_state_check
            check (state in ('open', 'revised', 'closed', 'cancelled'))
      `.execute(db);
    },
  }
