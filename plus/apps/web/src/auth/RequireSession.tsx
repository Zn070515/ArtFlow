import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { useSession } from "./SessionProvider.js";

export function RequireSession({ children }: { readonly children: ReactNode }) {
  const { session, isLoading } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!isLoading && session === null) {
      void navigate({ to: "/login", search: { next: location.pathname } });
    }
  }, [isLoading, session, navigate, location.pathname]);

  if (isLoading) return <p className="auth-loading">正在验证登录…</p>;
  if (session === null) return <p className="auth-loading">需要登录，正在跳转…</p>;
  return <>{children}</>;
}
