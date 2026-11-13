import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import {
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  registerParticipant,
  type SessionResponse,
} from "../api/auth.js";

interface SessionContextValue {
  readonly session: SessionResponse | null;
  readonly isLoading: boolean;
  readonly login: (username: string, password: string) => Promise<SessionResponse>;
  readonly register: (username: string, password: string) => Promise<SessionResponse>;
  readonly logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    staleTime: 60_000,
    retry: false,
  });

  const clearOtherQueries = useCallback((): void => {
    queryClient.removeQueries({
      predicate: (candidate) => candidate.queryKey[0] !== "me",
    });
  }, [queryClient]);

  const login = useCallback(
    async (username: string, password: string): Promise<SessionResponse> => {
      const session = await loginRequest(username, password);
      await queryClient.cancelQueries({ queryKey: ["me"] });
      queryClient.setQueryData(["me"], session);
      clearOtherQueries();
      return session;
    },
    [queryClient, clearOtherQueries],
  );

  const register = useCallback(
    async (username: string, password: string): Promise<SessionResponse> => {
      const session = await registerParticipant(username, password);
      await queryClient.cancelQueries({ queryKey: ["me"] });
      queryClient.setQueryData(["me"], session);
      clearOtherQueries();
      return session;
    },
    [queryClient, clearOtherQueries],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await logoutRequest();
    } finally {
      await queryClient.cancelQueries({ queryKey: ["me"] });
      queryClient.setQueryData(["me"], null);
      clearOtherQueries();
    }
  }, [queryClient, clearOtherQueries]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session: query.data ?? null,
      isLoading: query.isPending,
      login,
      register,
      logout,
    }),
    [query.data, query.isPending, login, register, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession must be used inside SessionProvider.");
  return value;
}

export function hasOpsAccess(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return (
    permissions.includes("*") ||
    permissions.includes("registration.review") ||
    permissions.includes("registration.manage")
  );
}

export function hasStudioAccess(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return permissions.includes("*") || permissions.includes("studio.manage");
}

export function hasLiveAccess(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return (
    permissions.includes("*") ||
    permissions.includes("competition.manage") ||
    permissions.includes("competition.score.write") ||
    permissions.includes("judge.manage")
  );
}

export function canPrepareCompetitionRound(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return permissions.includes("*") ||
    permissions.includes("competition.manage") ||
    permissions.includes("competition.round.prepare");
}

export function canManageCompetitionSetup(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return permissions.includes("*") || permissions.includes("competition.manage");
}

export function canResolveCompetition(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return permissions.includes("*") ||
    permissions.includes("competition.manage") ||
    permissions.includes("competition.score.write");
}

export function canManageLiveSession(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return permissions.includes("*") ||
    permissions.includes("studio.manage") ||
    permissions.includes("competition.manage");
}

export function canManageCompetition(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions } = session.actor;
  return (
    permissions.includes("*") ||
    permissions.includes("competition.manage") ||
    permissions.includes("competition.score.write")
  );
}

export function hasWorkspaceAccess(session: SessionResponse | null): boolean {
  return hasOpsAccess(session) || hasStudioAccess(session) || hasLiveAccess(session);
}

export function defaultLanding(session: SessionResponse): string {
  if (hasWorkspaceAccess(session)) return "/workspace";
  return "/join";
}
