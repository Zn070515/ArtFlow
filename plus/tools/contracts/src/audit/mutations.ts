export interface Mutation {
  readonly id: string;
  /** Path relative to the Plus workspace root. */
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly replaceAll?: boolean;
  readonly package: string;
  readonly testFile: string;
  readonly testName?: string;
  readonly guarantee: string;
}

/**
 * Critical guarantees that must be protected by at least one failing test when
 * removed. Add a mutation only when there is a focused test command that should
 * catch it; a survivor is a concrete weak-test finding, not a failure of the
 * mutation itself.
 */
export const MUTATIONS: readonly Mutation[] = [
  {
    id: "command.audit-removed",
    file: "packages/runtime/src/command.ts",
    find: "await insertAudit(trx, {",
    replace: "if (false) await insertAudit(trx, {",
    package: "@artflow-plus/contract-tools",
    testFile: "test/contracts/registration-contract.test.ts",
    guarantee: "receipt, audit, fact, and outbox share one transaction",
  },
  {
    id: "command.receipt-removed",
    file: "packages/runtime/src/command.ts",
    find: "await completeCommand(trx, meta.commandId, result.persistedBody ?? result.body, status);",
    replace: "// mutation: receipt completion removed",
    package: "@artflow-plus/contract-tools",
    testFile: "test/contracts/registration-contract.test.ts",
    testName: "replays a lost response without creating a second registration",
    guarantee: "a completed command can be replayed from its receipt",
  },
  {
    id: "registration.roster-start-removed",
    file: "packages/runtime/src/registration-service.ts",
    find: "await requireRosterOpen(trx, input.activityId);",
    replace: "// mutation: first roster guard removed",
    package: "@artflow-plus/runtime",
    testFile: "test/registration-service.test.ts",
    testName: "refuses to start, answer, or submit after the roster is final",
    guarantee: "a final roster freezes registration.start",
  },
  {
    id: "ticketing.judge-replay-removed",
    file: "packages/runtime/src/voting-ticket-service.ts",
    find: "onReplay: (_trx, result) => ({\n      ...result,\n      sessionToken: judgeSessionToken(result.sessionId, signingSecret),\n    }),",
    replace: "onReplay: undefined,",
    package: "@artflow-plus/contract-tools",
    testFile: "test/contracts/ticketing-contract.test.ts",
    testName: "replays a judge claim with a usable session token",
    guarantee: "a lost judge-claim response can be replayed into a usable token",
  },
  {
    id: "live.sticky-block-removed",
    file: "packages/db/src/live-state-repository.ts",
    find: 'if (current?.status === "blocked") return;',
    replace: "// mutation: sticky block removed",
    package: "@artflow-plus/runtime",
    testFile: "test/voting-ticket-service.test.ts",
    testName: "keeps a blocked live projection sticky until an explicit rebuild",
    guarantee: "a blocked live projection stays blocked until an explicit rebuild",
  },
  {
    id: "realtime.closed-checks-removed",
    file: "packages/realtime/src/server/connection.ts",
    find: "if (this.closed) return;",
    replace: "// mutation: closed check removed",
    replaceAll: true,
    package: "@artflow-plus/realtime",
    testFile: "test/server.test.ts",
    testName: "does not re-add a subscription when the socket closes during authorize",
    guarantee: "a close during async subscribe cannot create a ghost subscriber",
  },
  {
    id: "ticketing.archive-revoke-guard-removed",
    file: "packages/runtime/src/voting-ticket-service.ts",
    find: 'requireNotArchived(activity, "Ticket revocation");',
    replace: "// mutation: archive revoke guard removed",
    package: "@artflow-plus/runtime",
    testFile: "test/voting-ticket-service.test.ts",
    testName: "rejects ticket and judge capability writes after the activity is archived",
    guarantee: "an archived activity cannot revoke or rotate ticket credentials",
  },
  {
    id: "material.extension-check-removed",
    file: "packages/runtime/src/material-service.ts",
    find: 'if (!slot.accepts.some((extension) => lowerName.endsWith(extension.toLowerCase()))) {\n    throw new DomainError("MATERIAL_NOT_ALLOWED", "The material extension is not accepted by the released questionnaire.");\n  }',
    replace: "// mutation: extension check removed",
    package: "@artflow-plus/runtime",
    testFile: "test/registration-service.test.ts",
    guarantee: "a material whose extension is not accepted is rejected",
  },
];
