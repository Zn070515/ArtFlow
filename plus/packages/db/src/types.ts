import type { ColumnType, Generated } from "kysely";

export interface ActivityRow {
  id: string;
  public_code: ColumnType<string, string | undefined, string | undefined>;
  title: string;
  status: string;
  revision: number;
  // pg returns jsonb as an object, but a parameter must be sent as JSON text.
  enabled_capabilities: ColumnType<string[] | string, string, string>;
  active_definition_version: number;
  judge_entry_open: ColumnType<boolean, boolean | undefined, boolean | undefined>;
  judge_entry_version: ColumnType<number, number | undefined, number | undefined>;
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
  supplement_keys: ColumnType<unknown, string | undefined, string>;
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
  content_ready: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface MaterialCheckRow {
  id: string;
  activity_id: string;
  registration_id: string;
  slot_key: string;
  item_name: string;
  purpose: string;
  accepted_purposes: ColumnType<unknown, string, string>;
  status: string;
  required: boolean;
  review_note: string;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface SupplementGrantRow {
  id: string;
  activity_id: string;
  registration_id: string;
  token_digest: string;
  allowed_keys: ColumnType<unknown, string, string>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_by: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface ParticipantClaimRow {
  id: string;
  activity_id: string;
  registration_id: string;
  legacy_participant_id: string;
  token_digest: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  consumed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  consumed_by_actor_id: string | null;
  issued_by: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface ParticipantIdentityLinkRow {
  legacy_participant_id: string;
  actor_id: string;
  linked_at: ColumnType<Date, Date | string, Date | string>;
  linked_by: string;
  claim_id: string;
}

export interface CompetitionRoundRow {
  id: string;
  activity_id: string;
  round_key: string;
  release_version: number;
  state: string;
  revision: number;
  score_version: number;
  minimum_judges: number;
  judge_count: number;
  completion_mode: string;
  scoring_method: string;
  advance_count: number;
  current_panel_id: string | null;
  locked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface PanelSnapshotRow {
  id: string;
  activity_id: string;
  round_id: string;
  version: number;
  state: string;
  expected_judges: number;
  minimum_judges: number;
  roster_digest: string;
  context_version: number;
  current: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface PanelMemberRow {
  panel_id: string;
  judge_id: string;
  seat_key: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface JudgeSeatRow {
  id: string;
  panel_id: string;
  judge_id: string;
  state: string;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface PerformanceRow {
  id: string;
  activity_id: string;
  round_id: string;
  contestant_id: string;
  sequence: number;
  state: string;
  context_version: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface PerformanceScoreStateRow {
  performance_id: string;
  state: string;
  context_version: number;
  revision: number;
  opened_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  locked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ScoreFactRow {
  id: string;
  activity_id: string;
  round_id: string;
  performance_id: string;
  contestant_id: string;
  judge_id: string;
  panel_snapshot_id: string;
  seat_id: string;
  source: string;
  mode: string;
  total: ColumnType<string, string, string>;
  criteria: ColumnType<unknown, string, string>;
  notes: string;
  version: number;
  context_version: number;
  current: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ScoreRevisionRow {
  id: string;
  score_fact_id: string;
  version: number;
  source: string;
  total: ColumnType<string, string, string>;
  criteria: ColumnType<unknown, string, string>;
  reason: string;
  command_id: string;
  actor_id: string;
  created_at: ColumnType<Date, Date | string, Date | string>;
}

export interface ScoreCorrectionRow {
  id: string;
  score_fact_id: string;
  input_fingerprint: string;
  state: string;
  base_version: number;
  reason: string;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface RankingSnapshotRow {
  id: string;
  activity_id: string;
  round_id: string;
  mode: string;
  source_score_version: number;
  input_fingerprint: string;
  status: string;
  rows: ColumnType<unknown, string, string>;
  tie_groups: ColumnType<unknown, string, string>;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface AdvancementDecisionRow {
  id: string;
  activity_id: string;
  round_id: string;
  input_fingerprint: string;
  status: string;
  decisions: ColumnType<unknown, string, string>;
  decided_by: string | null;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface TieDecisionRow {
  id: string;
  activity_id: string;
  round_id: string;
  ranking_snapshot_id: string;
  input_fingerprint: string;
  contestants: ColumnType<unknown, string, string>;
  ordering: ColumnType<unknown, string, string>;
  reason: string;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface PodiumCandidateRow {
  id: string;
  activity_id: string;
  input_fingerprint: string;
  status: string;
  placements: ColumnType<unknown, string, string>;
  source_round_ids: ColumnType<unknown, string, string>;
  source_score_versions: ColumnType<unknown, string, string>;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface VoteSessionRow {
  id: string;
  activity_id: string;
  definition_version: number;
  mode: string;
  purpose: string;
  selection_type: string;
  max_selections: number;
    identity_policy: string;
  scoring_rule: ColumnType<unknown, string, string>;
  status: string;
  revision: number;
  opened_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  closed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface VoteOptionRow {
  id: string;
  activity_id: string;
  session_id: string;
  candidate_id: string;
  ordinal: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface BallotRow {
  id: string;
  activity_id: string;
  session_id: string;
  identity_type: string;
  identity_digest: string | null;
  ticket_id: string | null;
  submitted_at: ColumnType<Date, Date | string, Date | string>;
}

export interface VoteRecordRow {
  id: string;
  activity_id: string;
  session_id: string;
  ballot_id: string;
  option_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface TicketRow {
  id: string;
  activity_id: string;
  public_code: string;
  credential_digest: string;
  credential_version: number;
  state: string;
  issued_at: ColumnType<Date, Date | string, Date | string>;
  redeemed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface TicketAccessSessionRow {
  id: string;
  activity_id: string;
  ticket_id: string;
  token_digest: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  last_seen_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface JudgeSeatGrantRow {
  id: string;
  activity_id: string;
  seat_key: string;
  judge_id: string | null;
  state: string;
  session_id: string | null;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface JudgeSessionRow {
  id: string;
  activity_id: string;
  seat_id: string;
  actor_id: string;
  token_digest: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface LiveStateRow {
  activity_id: string;
  aggregate_type: string;
  aggregate_id: string;
  last_sequence: ColumnType<string, string | number, string | number>;
  state: ColumnType<unknown, string, string>;
  status: string;
  blocked_sequence: ColumnType<string | null, string | number | null, string | number | null>;
  blocked_reason: string | null;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface StageResultRow {
  id: string;
  activity_id: string;
  stage_key: string;
  status: string;
  candidate_revision: number;
  source_candidate_revision: number;
  input_fingerprint: string;
  decisions: ColumnType<unknown, string, string>;
  awards: ColumnType<unknown, string, string>;
  note: string;
  source: ColumnType<unknown, string | null | undefined, string | null>;
  stale_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  stale_reason: ColumnType<string, string | undefined, string>;
  revision: number;
  confirmed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  unlocked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ResultPublicationRow {
  id: string;
  activity_id: string;
  stage_key: string;
  title: string;
  content: string;
  version: number;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ResultReleaseRow {
  id: string;
  activity_id: string;
  publication_id: string;
  stage_result_id: string;
  stage_key: string;
  status: string;
  snapshot: ColumnType<unknown, string, string>;
  snapshot_candidate_revision: number;
  result_version: number;
  post_version: number;
  input_fingerprint: string;
  note: string;
  released_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  superseded_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface ArchivePackageRow {
  id: string;
  activity_id: string;
  version: number;
  key: string;
  size_bytes: number;
  sha256: string;
  manifest: ColumnType<unknown, string, string>;
  summary: ColumnType<unknown, string, string>;
  note: string;
  sealed_at: ColumnType<Date, Date | string, Date | string>;
  sealed_by: string;
  is_current: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface GroupingStageRow {
  id: string;
  activity_id: string;
  stage_key: string;
  name: string;
  status: string;
  roster_source: string;
  source_round_id: string | null;
  source_fingerprint: string;
  material_window: string;
  cancel_reason: string;
  confirmed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  confirmed_by: string | null;
  frozen_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  frozen_by: string | null;
  cancelled_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  cancelled_by: string | null;
  revision: number;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface GroupingGroupRow {
  id: string;
  stage_id: string;
  group_order: number;
  name: string;
  is_active: boolean;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface GroupingMembershipRow {
  id: string;
  stage_id: string;
  group_id: string;
  participant_id: string;
  is_current: boolean;
  joined_at: ColumnType<Date, Date | string, Date | string>;
  left_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  removed_by: string | null;
  reason: string;
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
  material_check: MaterialCheckRow;
  supplement_grant: SupplementGrantRow;
  participant_claim: ParticipantClaimRow;
  participant_identity_link: ParticipantIdentityLinkRow;
  competition_round: CompetitionRoundRow;
  panel_snapshot: PanelSnapshotRow;
  panel_member: PanelMemberRow;
  judge_seat: JudgeSeatRow;
  performance: PerformanceRow;
  performance_score_state: PerformanceScoreStateRow;
  score_fact: ScoreFactRow;
  score_revision: ScoreRevisionRow;
  score_correction: ScoreCorrectionRow;
  ranking_snapshot: RankingSnapshotRow;
  advancement_decision: AdvancementDecisionRow;
  tie_decision: TieDecisionRow;
  podium_candidate: PodiumCandidateRow;
  vote_session: VoteSessionRow;
  vote_option: VoteOptionRow;
  ballot: BallotRow;
  vote_record: VoteRecordRow;
  ticket: TicketRow;
  ticket_access_session: TicketAccessSessionRow;
  judge_seat_grant: JudgeSeatGrantRow;
  judge_session: JudgeSessionRow;
  live_state: LiveStateRow;
  stage_result: StageResultRow;
  result_publication: ResultPublicationRow;
  result_release: ResultReleaseRow;
  archive_package: ArchivePackageRow;
  grouping_stage: GroupingStageRow;
  grouping_group: GroupingGroupRow;
  grouping_membership: GroupingMembershipRow;
}
