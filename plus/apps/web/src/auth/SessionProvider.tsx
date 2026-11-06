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
  const { permissions, roles } = session.actor;
  return (
    permissions.includes("*") ||
    permissions.includes("registration.review") ||
    permissions.includes("registration.manage") ||
    roles.includes("staff") ||
    roles.includes("admin")
  );
}

export function hasStudioAccess(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions, roles } = session.actor;
  return permissions.includes("*") || permissions.includes("studio.manage") || roles.includes("admin");
}

export function hasLiveAccess(session: SessionResponse | null): boolean {
  if (session === null) return false;
  const { permissions, roles } = session.actor;
  return (
    permissions.includes("*") ||
    permissions.includes("competition.manage") ||
    permissions.includes("judge.manage") ||
    roles.includes("admin")
  );
}

export function defaultLanding(session: SessionResponse): string {
  if (hasOpsAccess(session)) return "/ops";
  if (hasStudioAccess(session)) return "/studio";
  return "/join";
}
