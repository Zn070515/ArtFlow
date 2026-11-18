import { useQuery } from "@tanstack/react-query";

import { fetchPacks } from "../api/studio.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasStudioAccess, useSession } from "../auth/SessionProvider.js";
import { StudioWizard } from "../components/studio/StudioWizard.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";

export function StudioNewPage() {
  return (
    <RequireSession>
      <StudioNewContent />
    </RequireSession>
  );
}

function StudioNewContent() {
  const { session } = useSession();
  const allowed = hasStudioAccess(session);
  const query = useQuery({
    queryKey: ["packs"],
    queryFn: fetchPacks,
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return (
      <EmptyState
        title="没有 Studio 权限"
        description="当前账号缺少 studio.manage。"
      />
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动模板…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="活动模板暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }
  return <StudioWizard packs={query.data} />;
}
