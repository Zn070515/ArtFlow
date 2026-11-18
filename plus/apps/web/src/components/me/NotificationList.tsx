import type { MyNotification } from "../../api/me.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";

export function NotificationList({
  items,
  unreadCount,
  busy,
  onOpen,
  onMarkAll,
}: {
  readonly items: readonly MyNotification[];
  readonly unreadCount: number;
  readonly busy: boolean;
  readonly onOpen: (item: MyNotification) => void;
  readonly onMarkAll: () => void;
}) {
  return (
    <section className="me-notifications" aria-labelledby="me-notifications-title">
      <header className="me-notifications__head">
        <h2 className="ui-card__title" id="me-notifications-title">通知</h2>
        <span className="me-notifications__count">{unreadCount} 条未读</span>
        {unreadCount === 0 ? null : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onMarkAll}>
            全部已读
          </Button>
        )}
      </header>
      {items.length === 0 ? (
        <EmptyState title="暂无通知" description="报名审核、材料、节目单和赛果更新会出现在这里。" />
      ) : (
        <ul className="me-notifications__list">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className={item.read ? "me-notification" : "me-notification is-unread"}
                onClick={() => onOpen(item)}
              >
                <span className="me-notification__dot" aria-hidden="true" />
                <span className="me-notification__title">{item.title}</span>
                <span className="me-notification__body">{item.body}</span>
                <time className="me-notification__time" dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
