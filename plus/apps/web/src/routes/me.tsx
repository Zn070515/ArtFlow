import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  fetchMyCenter,
  markMyNotificationsRead,
  type MyCenter,
  type MyNotification,
} from "../api/me.js";
import { RequireSession } from "../auth/RequireSession.js";
import { MyEventCard } from "../components/me/MyEventCard.js";
import { NotificationList } from "../components/me/NotificationList.js";
import { SecurityCard } from "../components/me/SecurityCard.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";

export function MePage() {
  return (
    <RequireSession>
      <MeContent />
    </RequireSession>
  );
}

function MeContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["my-center"],
    queryFn: ({ signal }) => fetchMyCenter(signal),
    staleTime: 0,
    retry: false,
  });
  const markRead = useMutation({
    mutationFn: (keys: readonly string[]) => markMyNotificationsRead(keys),
    onSuccess: (result, keys) => {
      queryClient.setQueryData<MyCenter>(["my-center"], (current) => {
        if (current === undefined) return current;
        return {
          ...current,
          notifications: {
            ...current.notifications,
            items: current.notifications.items.map((item) =>
              keys.includes(item.key) ? { ...item, read: true } : item),
            unreadCount: result.unreadCount,
          },
        };
      });
    },
  });

  useEffect(() => {
    document.title = "我的 · ArtFlow";
  }, []);

  function open(item: MyNotification): void {
    markRead.mutate([item.key]);
    void navigate({ to: "/me/$publicCode", params: { publicCode: item.activity.publicCode } });
  }

  if (query.isPending) return <p className="me-state">正在加载我的活动…</p>;
  if (query.error !== null) {
    return <ErrorState description="个人中心暂时无法加载。" onRetry={() => void query.refetch()} />;
  }
  const center = query.data;
  if (center === undefined) return null;
  return (
    <section className="me-page">
      <header className="me-header">
        <div>
          <p className="eyebrow">MY ARTFLOW</p>
          <h1 className="ui-page-title">我的</h1>
          <p className="ui-page-meta">报名、材料、个人赛程与赛果。</p>
        </div>
        <Link className="ui-button ui-button--secondary ui-button--md" to="/join">报名新活动</Link>
      </header>
      <div className="me-grid">
        <div className="me-events">
          {center.events.length === 0 ? (
            <EmptyState
              title="还没有报名任何活动"
              description="输入活动公开码开始报名。"
              action={<Link className="ui-button ui-button--primary ui-button--md" to="/join">去报名</Link>}
            />
          ) : center.events.map((event) => (
            <MyEventCard key={event.activity.publicCode} event={event} />
          ))}
        </div>
        <aside className="me-rail">
          <NotificationList
            items={center.notifications.items}
            unreadCount={center.notifications.unreadCount}
            busy={markRead.isPending}
            onOpen={open}
            onMarkAll={() => markRead.mutate(center.notifications.items.map((item) => item.key))}
          />
          <SecurityCard />
        </aside>
      </div>
    </section>
  );
}
