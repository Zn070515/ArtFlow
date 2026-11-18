import type { LiveSession, LiveState } from "../../api/live.js";

export type LiveSessionState = "none" | "running";
export type LivePhase =
  | "inactive"
  | "no_session"
  | "awaiting_start"
  | "scoring"
  | "round_scored"
  | "round_hold"
  | "round_resolved"
  | "completed";

export interface LiveCommandView {
  readonly session: LiveSessionState;
  readonly mode: LiveSession["mode"] | null;
  readonly phase: LivePhase;
  readonly focusRoundKey: string | null;
  readonly focusRoundIndex: number | null;
  readonly current: {
    readonly performanceId: string;
    readonly sequence: number;
    readonly participantId: string;
    readonly scoreCount: number;
    readonly expectedJudges: number;
  } | null;
  readonly next: {
    readonly kind: "performance" | "round" | "blocked";
    readonly roundKey: string;
    readonly roundIndex: number;
    readonly sequence?: number;
    readonly participantId?: string;
    readonly label: string;
  } | null;
  readonly rounds: readonly {
    readonly key: string;
    readonly index: number;
    readonly state: "none" | "prepared" | "scoring" | "locked" | "resolved";
    readonly lockedPerformances: number;
    readonly totalPerformances: number;
    readonly hold: boolean;
  }[];
  readonly seats: { readonly assigned: number; readonly expected: number; readonly minimum: number };
  readonly readyToScore: boolean;
  readonly activityStatus: LiveState["activity"]["status"];
}

export function deriveLiveCommand(state: LiveState): LiveCommandView {
  const session: LiveSessionState = state.session === null ? "none" : "running";
  const mode = state.session?.mode ?? null;
  const rounds = state.rounds.map((round, index) => ({
    key: round.config.key,
    index,
    state: round.round?.state ?? ("none" as const),
    lockedPerformances: round.performances.filter((performance) => performance.state === "locked").length,
    totalPerformances: round.performances.length,
    hold: round.ranking?.status === "hold",
  }));
  const base = {
    session,
    mode,
    activityStatus: state.activity.status,
    rounds,
    seats: { assigned: 0, expected: 0, minimum: 0 },
    readyToScore: false,
  };

  if (state.activity.status === "closed" || state.activity.status === "archived") {
    return {
      ...base,
      phase: "inactive",
      focusRoundKey: null,
      focusRoundIndex: null,
      current: null,
      next: null,
    };
  }

  const focusIndex = state.rounds.findIndex((round) => round.round?.state !== "resolved");
  if (focusIndex === -1) {
    return {
      ...base,
      phase: "completed",
      focusRoundKey: null,
      focusRoundIndex: null,
      current: null,
      next: null,
    };
  }

  const focus = state.rounds[focusIndex]!;
  const focusKey = focus.config.key;
  const seatsAssigned = focus.seats.filter((seat) => seat.state === "assigned").length;
  const seats = {
    assigned: seatsAssigned,
    expected: focus.config.judgeCount,
    minimum: focus.config.minimumJudges,
  };
  const nextRound = state.rounds[focusIndex + 1];
  const nextRoundLabel = nextRound === undefined
    ? null
    : nextRound.round === null
      ? {
          kind: "round" as const,
          roundKey: nextRound.config.key,
          roundIndex: focusIndex + 1,
          label: `准备第 ${focusIndex + 2} 轮`,
        }
      : {
          kind: "performance" as const,
          roundKey: nextRound.config.key,
          roundIndex: focusIndex + 1,
          label: `下一轮：第 ${focusIndex + 2} 轮`,
        };
  const focusRound = focus.round;

  if (focusRound === null) {
    return {
      ...base,
      seats,
      phase: session === "none" ? "no_session" : "awaiting_start",
      focusRoundKey: focusKey,
      focusRoundIndex: focusIndex,
      current: null,
      next: session === "none"
        ? null
        : { kind: "round", roundKey: focusKey, roundIndex: focusIndex, label: `准备第 ${focusIndex + 1} 轮` },
    };
  }

  const open = focus.performances.find((performance) => performance.state === "open");
  const notOpened = focus.performances
    .filter((performance) => performance.state === "not_opened")
    .sort((left, right) => left.sequence - right.sequence);
  const current = open === undefined
    ? null
    : {
        performanceId: open.id,
        sequence: open.sequence,
        participantId: open.contestantId,
        scoreCount: open.scoreCount,
        expectedJudges: open.expectedJudges,
      };
  const nextPerformance = notOpened[0];
  const readyToScore = session === "running" &&
    focusRound.state === "scoring" &&
    focus.panel !== null &&
    focus.panel.current &&
    open !== undefined &&
    seatsAssigned >= seats.minimum;

  if (focusRound.state === "prepared" || focusRound.state === "scoring") {
    if (focus.performances.length === 0) {
      return {
        ...base,
        seats,
        phase: "awaiting_start",
        focusRoundKey: focusKey,
        focusRoundIndex: focusIndex,
        current: null,
        next: {
          kind: "round",
          roundKey: focusKey,
          roundIndex: focusIndex,
          label: `第 ${focusIndex + 1} 轮待准备`,
        },
      };
    }
    if (open !== undefined) {
      const next = nextPerformance === undefined
        ? null
        : {
            kind: "performance" as const,
            roundKey: focusKey,
            roundIndex: focusIndex,
            sequence: nextPerformance.sequence,
            participantId: nextPerformance.contestantId,
            label: `第 ${focusIndex + 1} 轮 · 第 ${nextPerformance.sequence} 位`,
          };
      return {
        ...base,
        seats,
        readyToScore,
        phase: "scoring",
        focusRoundKey: focusKey,
        focusRoundIndex: focusIndex,
        current,
        next,
      };
    }
    if (nextPerformance !== undefined) {
      return {
        ...base,
        seats,
        phase: "awaiting_start",
        focusRoundKey: focusKey,
        focusRoundIndex: focusIndex,
        current: null,
        next: {
          kind: "performance",
          roundKey: focusKey,
          roundIndex: focusIndex,
          sequence: nextPerformance.sequence,
          participantId: nextPerformance.contestantId,
          label: `第 ${focusIndex + 1} 轮 · 第 ${nextPerformance.sequence} 位`,
        },
      };
    }
    return {
      ...base,
      seats,
      phase: "round_scored",
      focusRoundKey: focusKey,
      focusRoundIndex: focusIndex,
      current: null,
      next: null,
    };
  }

  if (focusRound.state === "locked") {
    if (focus.ranking === null || focus.ranking.status === "hold") {
      return {
        ...base,
        seats,
        phase: "round_hold",
        focusRoundKey: focusKey,
        focusRoundIndex: focusIndex,
        current: null,
        next: {
          kind: "blocked",
          roundKey: focusKey,
          roundIndex: focusIndex,
          label: "先处理 HOLD/解析排名",
        },
      };
    }
    return {
      ...base,
      seats,
      phase: "round_resolved",
      focusRoundKey: focusKey,
      focusRoundIndex: focusIndex,
      current: null,
      next: nextRoundLabel,
    };
  }

  return {
    ...base,
    seats,
    phase: "round_resolved",
    focusRoundKey: focusKey,
    focusRoundIndex: focusIndex,
    current: null,
    next: nextRoundLabel,
  };
}
