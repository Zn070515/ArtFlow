import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  createAccount,
  fetchAccounts,
  inviteAccount,
  revokeAccountInvite,
  revokeAccountSessions,
  updateAccount,
  type AccountSummary,
} from "../api/accounts.js";
import { RequireSession } from "../auth/RequireSession.js";
import { canManageAccounts, useSession } from "../auth/SessionProvider.js";
import { ConsolePagination } from "../components/console/ConsolePagination.js";
import { Button } from "../components/ui/Button.js";
import { ConfirmDialog, FormDialog } from "../components/ui/Dialog.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { Input } from "../components/ui/Input.js";
import { Table } from "../components/ui/Table.js";
import { apiErrorText } from "../components/ui/apiError.js";

export function AccountsPage() {
  return (
    <RequireSession>
      <AccountsContent />
    </RequireSession>
  );
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const PAGE_SIZE = 25;

function splitList(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

function AccountsContent() {
  const { session } = useSession();
  const allowed = canManageAccounts(session);
  const [showParticipants, setShowParticipants] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [showParticipants]);
  const query = useQuery({
    queryKey: ["admin-accounts", showParticipants, page],
    queryFn: () => fetchAccounts({
      includeParticipants: showParticipants,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    enabled: allowed,
    retry: false,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    username: "",
    password: "",
    roles: "staff",
    permissions: "",
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    username: "",
    roles: "staff",
    permissions: "",
  });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
  const [editForm, setEditForm] = useState({
    roles: "",
    permissions: "",
    active: true,
    password: "",
    accessRevision: 0,
  });
  const [revoking, setRevoking] = useState<AccountSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!allowed) {
    return (
      <EmptyState
        title="没有账号管理权限"
        description="只有持有 account.manage 的账号可以管理团队。"
      />
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载账号…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="账号列表暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }

  async function submitCreate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await createAccount({
        username: createForm.username.trim(),
        password: createForm.password,
        roles: splitList(createForm.roles),
        permissions: splitList(createForm.permissions),
      });
      setCreateOpen(false);
      setCreateForm({ username: "", password: "", roles: "staff", permissions: "" });
      setPage(1);
      await query.refetch();
    } catch (cause) {
      setError(apiErrorText(cause, "创建账号失败。", "账号已存在或状态冲突。"));
    } finally {
      setBusy(false);
    }
  }

  async function submitInvite(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const created = await inviteAccount({
        username: inviteForm.username.trim(),
        roles: splitList(inviteForm.roles),
        permissions: splitList(inviteForm.permissions),
      });
      setInviteLink(`${window.location.origin}/claim#${created.token}`);
      setInviteOpen(false);
      setInviteForm({ username: "", roles: "staff", permissions: "" });
      setPage(1);
      await query.refetch();
    } catch (cause) {
      setError(apiErrorText(
        cause,
        "创建邀请失败。",
        "该账号已启用；请改用重置密码或撤销会话。",
      ));
    } finally {
      setBusy(false);
    }
  }

  async function submitRevokeInvite(account: AccountSummary): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await revokeAccountInvite(account.username);
      await query.refetch();
    } catch (cause) {
      setError(apiErrorText(cause, "撤销邀请失败。", "邀请已失效。"));
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(account: AccountSummary): void {
    setEditing(account);
    setEditForm({
      roles: account.roles.join(", "),
      permissions: account.permissions.join(", "),
      active: account.active,
      password: "",
      accessRevision: account.accessRevision,
    });
  }

  async function submitEdit(): Promise<void> {
    if (editing === null) return;
    setBusy(true);
    setError(null);
    try {
      await updateAccount(editing.username, {
        roles: splitList(editForm.roles),
        permissions: splitList(editForm.permissions),
        active: editForm.active,
        ...(editForm.password === "" ? {} : { password: editForm.password }),
        expectedRevision: editForm.accessRevision,
      });
      setEditing(null);
      await query.refetch();
    } catch (cause) {
      setError(apiErrorText(cause, "保存账号失败。", "该变更会移除最后一个管理员，或账号状态已变化。"));
    } finally {
      setBusy(false);
    }
  }

  async function submitRevoke(): Promise<void> {
    if (revoking === null) return;
    setBusy(true);
    setError(null);
    try {
      await revokeAccountSessions(revoking.username);
      setRevoking(null);
      await query.refetch();
    } catch (cause) {
      setError(apiErrorText(cause, "撤销会话失败。", "账号状态已变化，请刷新后重试。"));
    } finally {
      setBusy(false);
    }
  }

  // Participants share the account table but are not part of the organizing
  // team; showing every registrant here would bury the staff list.
  const visibleAccounts = query.data.accounts.filter(
    (account) =>
      showParticipants ||
      account.permissions.length > 0 ||
      account.roles.some((role) => role !== "participant"),
  );
  const totalPages = Math.max(1, Math.ceil(query.data.total / PAGE_SIZE));

  return (
    <section className="ops-page">
      <header className="ops-header">
        <h1 className="ui-page-title">账号与权限</h1>
        <p className="ui-page-meta">
          共 {query.data.total} 个账号 · 第 {page} / {totalPages} 页 ·
          权限变更对已登录会话立即生效
        </p>
      </header>

      <div className="ui-toolbar" role="group" aria-label="账号操作">
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          新建账号
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setInviteForm({ username: "", roles: "staff", permissions: "" });
            setInviteOpen(true);
          }}
        >
          邀请成员
        </Button>
        <label className="ui-field__label">
          <input
            type="checkbox"
            checked={showParticipants}
            onChange={(event) => setShowParticipants(event.target.checked)}
          />{" "}
          显示参与者账号
        </label>
      </div>

      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}

      {query.data.accounts.length === 0 ? (
        <EmptyState
          title={query.data.total === 0 ? "还没有账号" : "这一页没有账号"}
          description={query.data.total === 0
            ? "创建第一个团队账号。"
            : "返回上一页，或调整参与者账号筛选。"}
        />
      ) : visibleAccounts.length === 0 ? (
        <EmptyState
          title="没有团队账号"
          description="当前只有参与者账号；勾选“显示参与者账号”可以查看。"
        />
      ) : (
        <Table caption="账号列表">
          <thead>
            <tr>
              <th scope="col">账号</th>
              <th scope="col">角色</th>
              <th scope="col">权限</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleAccounts.map((account) => (
              <tr key={account.username}>
                <td data-label="账号">{account.username}</td>
                <td data-label="角色">{account.roles.join(", ") || "—"}</td>
                <td data-label="权限">{account.permissions.join(", ") || "—"}</td>
                <td data-label="状态">
                  {account.invited ? "待认领" : account.active ? "启用" : "已停用"}
                </td>
                <td data-label="操作">
                  <div className="ui-inline-actions">
                    <Button size="sm" onClick={() => beginEdit(account)}>
                      编辑
                    </Button>
                    {account.invited ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => { void submitRevokeInvite(account); }}
                      >
                        撤销邀请
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setRevoking(account)}
                      >
                        撤销会话
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ConsolePagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <FormDialog
        open={createOpen}
        title="新建账号"
        description="新账号创建后即可登录；权限可随时调整。"
        confirmLabel="创建"
        onCancel={() => setCreateOpen(false)}
        onConfirm={() => {
          setCreateOpen(false);
          void submitCreate();
        }}
        validate={() => {
          if (!USERNAME_PATTERN.test(createForm.username.trim())) {
            return "用户名需为 3-64 位字母、数字、点、横线或下划线。";
          }
          if (createForm.password.length < 8) return "密码至少 8 位。";
          return null;
        }}
      >
        <Input
          label="用户名"
          value={createForm.username}
          onChange={(event) => setCreateForm({ ...createForm, username: event.target.value })}
          autoFocus
        />
        <Input
          label="初始密码"
          type="password"
          value={createForm.password}
          onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })}
          hint="至少 8 位"
        />
        <Input
          label="角色"
          value={createForm.roles}
          onChange={(event) => setCreateForm({ ...createForm, roles: event.target.value })}
          hint="逗号或空格分隔，例如 staff, judge"
        />
        <Input
          label="权限"
          value={createForm.permissions}
          onChange={(event) => setCreateForm({ ...createForm, permissions: event.target.value })}
          hint="逗号或空格分隔，例如 registration.review"
        />
      </FormDialog>

      <FormDialog
        open={inviteOpen}
        title="邀请成员"
        description="生成一次性链接；对方设置密码后才能登录。链接只显示一次。"
        confirmLabel="生成链接"
        onCancel={() => setInviteOpen(false)}
        onConfirm={() => {
          setInviteOpen(false);
          void submitInvite();
        }}
        validate={() => {
          if (!USERNAME_PATTERN.test(inviteForm.username.trim())) {
            return "用户名需为 3-64 位字母、数字、点、横线或下划线。";
          }
          return null;
        }}
      >
        <Input
          label="用户名"
          value={inviteForm.username}
          onChange={(event) => setInviteForm({ ...inviteForm, username: event.target.value })}
          autoFocus
        />
        <Input
          label="角色"
          value={inviteForm.roles}
          onChange={(event) => setInviteForm({ ...inviteForm, roles: event.target.value })}
          hint="逗号或空格分隔，例如 staff, judge"
        />
        <Input
          label="权限"
          value={inviteForm.permissions}
          onChange={(event) => setInviteForm({ ...inviteForm, permissions: event.target.value })}
          hint="逗号或空格分隔，例如 registration.review"
        />
      </FormDialog>

      <FormDialog
        open={inviteLink !== null}
        title="邀请链接（仅显示一次）"
        description="通过安全渠道发送；对方打开后设置密码并立即生效。"
        confirmLabel="完成"
        onCancel={() => setInviteLink(null)}
        onConfirm={() => setInviteLink(null)}
      >
        <Input label="邀请链接" readOnly value={inviteLink ?? ""} />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            if (inviteLink !== null) void navigator.clipboard?.writeText(inviteLink);
          }}
        >
          复制链接
        </Button>
      </FormDialog>

      <FormDialog
        open={editing !== null}
        title={editing === null ? "编辑账号" : `编辑 ${editing.username}`}
        description="修改会立即影响该账号已登录的会话；停用或重置密码会强制所有设备退出。"
        confirmLabel="保存"
        onCancel={() => setEditing(null)}
        onConfirm={() => {
          setEditing(null);
          void submitEdit();
        }}
        validate={() => (editForm.password !== "" && editForm.password.length < 8 ? "密码至少 8 位。" : null)}
      >
        <Input
          label="角色"
          value={editForm.roles}
          onChange={(event) => setEditForm({ ...editForm, roles: event.target.value })}
          hint="逗号或空格分隔"
        />
        <Input
          label="权限"
          value={editForm.permissions}
          onChange={(event) => setEditForm({ ...editForm, permissions: event.target.value })}
          hint="逗号或空格分隔；至少保留一个启用账号持有 account.manage"
        />
        <label className="ui-field__label">
          <input
            type="checkbox"
            checked={editForm.active}
            onChange={(event) => setEditForm({ ...editForm, active: event.target.checked })}
          />{" "}
          账号启用
        </label>
        <Input
          label="重置密码（可选）"
          type="password"
          value={editForm.password}
          onChange={(event) => setEditForm({ ...editForm, password: event.target.value })}
          hint="留空表示不修改"
        />
      </FormDialog>

      <ConfirmDialog
        open={revoking !== null}
        title="撤销全部会话"
        description={
          revoking === null
            ? ""
            : `${revoking.username} 的所有设备将立即退出登录；账号本身仍可再次登录。`
        }
        confirmLabel="撤销"
        danger
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          setRevoking(null);
          void submitRevoke();
        }}
      />
    </section>
  );
}
