import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import type { Database } from "../types.js";

export const migration: Migration = {
    async up(db: Kysely<Database>): Promise<void> {
      await db.schema.alterTable("activity")
        .addColumn("public_code", "varchar(100)", (column) => column.notNull().defaultTo(""))
        .execute();
      await sql`update activity set public_code = id where public_code = ''`.execute(db);
      await sql`create unique index activity_public_code_key on activity(public_code) where public_code <> ''`.execute(db);
      await db.schema.alterTable("activity")
        .addColumn("judge_entry_open", "boolean", (column) => column.notNull().defaultTo(true))
        .addColumn("judge_entry_version", "integer", (column) => column.notNull().defaultTo(1))
        .execute();

      await db.schema
        .createTable("vote_session")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("definition_version", "integer", (column) => column.notNull())
        .addColumn("purpose", "varchar(30)", (column) => column.notNull())
        .addColumn("selection_type", "varchar(10)", (column) => column.notNull())
        .addColumn("max_selections", "integer", (column) => column.notNull())
        .addColumn("requires_ticket", "boolean", (column) => column.notNull())
        .addColumn("allow_browser_identity", "boolean", (column) => column.notNull())
        .addColumn("scoring_rule", "jsonb", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull())
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("opened_at", "timestamptz")
        .addColumn("closed_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("vote_session_status_check", sql`status in ('draft', 'open', 'closed')`)
        .addCheckConstraint("vote_session_purpose_check", sql`purpose in ('popularity', 'score_component')`)
        .addCheckConstraint("vote_session_selection_check", sql`selection_type in ('single', 'multi') and max_selections >= 1`)
        .addCheckConstraint("vote_session_identity_check", sql`not (requires_ticket and allow_browser_identity)`)
        .execute();
      await sql`create index vote_session_activity_idx on vote_session(activity_id, status)`.execute(db);

      await db.schema
        .createTable("vote_option")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("session_id", "varchar(100)", (column) => column.notNull().references("vote_session.id").onDelete("restrict"))
        .addColumn("candidate_id", "varchar(100)", (column) => column.notNull())
        .addColumn("ordinal", "integer", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("vote_option_session_candidate_key", ["session_id", "candidate_id"])
        .execute();

      await db.schema
        .createTable("ticket")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("public_code", "varchar(32)", (column) => column.notNull().unique())
        .addColumn("credential_digest", "varchar(64)", (column) => column.notNull().unique())
        .addColumn("credential_version", "integer", (column) => column.notNull().defaultTo(1))
        .addColumn("state", "varchar(20)", (column) => column.notNull())
        .addColumn("issued_at", "timestamptz", (column) => column.notNull())
        .addColumn("redeemed_at", "timestamptz")
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("ticket_state_check", sql`state in ('issued', 'redeemed', 'revoked', 'expired')`)
        .addCheckConstraint("ticket_version_check", sql`credential_version >= 1`)
        .execute();
      await sql`create index ticket_activity_state_idx on ticket(activity_id, state)`.execute(db);

      await db.schema
        .createTable("ballot")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("session_id", "varchar(100)", (column) => column.notNull().references("vote_session.id").onDelete("restrict"))
        .addColumn("identity_type", "varchar(20)", (column) => column.notNull())
        .addColumn("identity_digest", "varchar(64)")
        .addColumn("ticket_id", "varchar(100)", (column) => column.references("ticket.id").onDelete("restrict"))
        .addColumn("submitted_at", "timestamptz", (column) => column.notNull())
        .addCheckConstraint("ballot_identity_type_check", sql`identity_type in ('ticket', 'browser', 'anonymous')`)
        .addCheckConstraint("ballot_identity_shape_check", sql`(identity_type = 'ticket' and ticket_id is not null and identity_digest is null) or (identity_type = 'browser' and ticket_id is null and identity_digest is not null) or (identity_type = 'anonymous' and ticket_id is null and identity_digest is null)`)
        .execute();
      await sql`create unique index ballot_ticket_identity_key on ballot(session_id, ticket_id) where identity_type = 'ticket'`.execute(db);
      await sql`create unique index ballot_browser_identity_key on ballot(session_id, identity_digest) where identity_type = 'browser'`.execute(db);
      await sql`create index ballot_session_idx on ballot(session_id, submitted_at)`.execute(db);

      await db.schema
        .createTable("vote_record")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("session_id", "varchar(100)", (column) => column.notNull().references("vote_session.id").onDelete("restrict"))
        .addColumn("ballot_id", "varchar(100)", (column) => column.notNull().references("ballot.id").onDelete("restrict"))
        .addColumn("option_id", "varchar(100)", (column) => column.notNull().references("vote_option.id").onDelete("restrict"))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint("vote_record_ballot_option_key", ["ballot_id", "option_id"])
        .execute();

      await db.schema
        .createTable("ticket_access_session")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("ticket_id", "varchar(100)", (column) => column.notNull().references("ticket.id").onDelete("restrict"))
        .addColumn("token_digest", "varchar(64)", (column) => column.notNull().unique())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("last_seen_at", "timestamptz")
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createTable("judge_seat_grant")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("seat_key", "varchar(100)", (column) => column.notNull())
        .addColumn("judge_id", "varchar(100)")
        .addColumn("state", "varchar(20)", (column) => column.notNull().defaultTo("available"))
        .addColumn("session_id", "varchar(100)")
        .addColumn("revision", "integer", (column) => column.notNull().defaultTo(0))
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addCheckConstraint("judge_seat_grant_state_check", sql`state in ('available', 'claimed', 'revoked')`)
        .addUniqueConstraint("judge_seat_grant_activity_key", ["activity_id", "seat_key"])
        .execute();

      await db.schema
        .createTable("judge_session")
        .addColumn("id", "varchar(100)", (column) => column.primaryKey())
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("restrict"))
        .addColumn("seat_id", "varchar(100)", (column) => column.notNull().references("judge_seat_grant.id").onDelete("restrict"))
        .addColumn("actor_id", "varchar(100)", (column) => column.notNull())
        .addColumn("token_digest", "varchar(64)", (column) => column.notNull().unique())
        .addColumn("expires_at", "timestamptz", (column) => column.notNull())
        .addColumn("revoked_at", "timestamptz")
        .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .execute();

      await db.schema
        .createTable("live_state")
        .addColumn("activity_id", "varchar(100)", (column) => column.notNull().references("activity.id").onDelete("cascade"))
        .addColumn("aggregate_type", "varchar(100)", (column) => column.notNull())
        .addColumn("aggregate_id", "varchar(100)", (column) => column.notNull())
        .addColumn("last_sequence", "bigint", (column) => column.notNull().defaultTo(0))
        .addColumn("state", "jsonb", (column) => column.notNull())
        .addColumn("status", "varchar(20)", (column) => column.notNull().defaultTo("running"))
        .addColumn("blocked_sequence", "bigint")
        .addColumn("blocked_reason", "text")
        .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
        .addPrimaryKeyConstraint("live_state_pkey", ["activity_id", "aggregate_type", "aggregate_id"])
        .addCheckConstraint("live_state_status_check", sql`status in ('running', 'blocked')`)
        .execute();

      // Keep the activity/session identity aligned even for direct SQL writers.
      // The runtime repeats these checks for capability-aware error semantics;
      // the composite foreign keys make the database boundary authoritative.
      await sql`
        alter table vote_session
          add constraint vote_session_activity_key unique (id, activity_id);
        alter table vote_option
          add constraint vote_option_activity_session_key unique (id, activity_id, session_id),
          add constraint vote_option_activity_session_fk
            foreign key (session_id, activity_id)
            references vote_session (id, activity_id)
            on delete restrict;
        alter table ticket
          add constraint ticket_activity_key unique (id, activity_id);
        alter table ballot
          add constraint ballot_activity_session_key unique (id, activity_id, session_id),
          add constraint ballot_activity_session_fk
            foreign key (session_id, activity_id)
            references vote_session (id, activity_id)
            on delete restrict;
        alter table vote_record
          add constraint vote_record_ballot_activity_session_fk
            foreign key (ballot_id, activity_id, session_id)
            references ballot (id, activity_id, session_id)
            on delete restrict,
          add constraint vote_record_option_activity_session_fk
            foreign key (option_id, activity_id, session_id)
            references vote_option (id, activity_id, session_id)
            on delete restrict;
        alter table ticket_access_session
          add constraint ticket_access_session_ticket_activity_fk
            foreign key (ticket_id, activity_id)
            references ticket (id, activity_id)
            on delete restrict;
        alter table judge_seat_grant
          add constraint judge_seat_grant_activity_key2 unique (id, activity_id);
        alter table judge_session
          add constraint judge_session_seat_activity_fk
            foreign key (seat_id, activity_id)
            references judge_seat_grant (id, activity_id)
            on delete restrict;
      `.execute(db);
    },
    async down(db: Kysely<Database>): Promise<void> {
      await db.schema.dropTable("live_state").ifExists().execute();
      await db.schema.dropTable("judge_session").ifExists().execute();
      await db.schema.dropTable("judge_seat_grant").ifExists().execute();
      await db.schema.dropTable("ticket_access_session").ifExists().execute();
      await db.schema.dropTable("vote_record").ifExists().execute();
      await sql`drop index if exists ballot_browser_identity_key`.execute(db);
      await sql`drop index if exists ballot_ticket_identity_key`.execute(db);
      await sql`drop index if exists ballot_session_idx`.execute(db);
      await db.schema.dropTable("ballot").ifExists().execute();
      await sql`drop index if exists ticket_activity_state_idx`.execute(db);
      await db.schema.dropTable("ticket").ifExists().execute();
      await db.schema.dropTable("vote_option").ifExists().execute();
      await sql`drop index if exists vote_session_activity_idx`.execute(db);
      await db.schema.dropTable("vote_session").ifExists().execute();
      await db.schema.alterTable("activity").dropColumn("judge_entry_version").execute();
      await db.schema.alterTable("activity").dropColumn("judge_entry_open").execute();
      await sql`drop index if exists activity_public_code_key`.execute(db);
      await db.schema.alterTable("activity").dropColumn("public_code").execute();
    },
  }
