import type { Database } from "@artflow-plus/db";
import { existsFormalScoreFactsForRound } from "@artflow-plus/db";
import { DomainError, type ExecutionMode } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

/**
 * Once a round has any formal score fact, non-formal execution may no longer
 * mutate its shared lifecycle (performance/round state is not mode-scoped).
 */
export async function requireNoFormalFacts(
  trx: Kysely<Database>,
  roundId: string,
  mode: ExecutionMode,
): Promise<void> {
  if (mode === "formal") return;
  if (await existsFormalScoreFactsForRound(trx, roundId)) {
    throw new DomainError(
      "FORMAL_FACTS_EXIST",
      "Formal score facts exist; rehearse in a copied activity.",
    );
  }
}
