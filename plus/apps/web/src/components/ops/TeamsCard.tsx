import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  addTeamMember,
  correctTeamRoster,
  createTeam,
  fetchTeams,
  freezeTeamRoster,
  importTeamsFromGrouping,
  removeTeamMember,
  updateTeam,
  withdrawTeam,
  type RosterSpecTeam,
  type TeamMemberRole,
  type TeamView,
  type TeamsView,
} from "../../api/teams.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";
import { apiErrorText } from "../ui/apiError.js";

const STATUS_LABELS: Readonly<Record<TeamView["status"], string>> = {
  draft: "草稿",
  frozen: "已冻结",
  withdrawn: "已退赛",
};

interface CorrectionTeam {
  readonly teamKey: string;
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly captainId: string;
}

function correctionTeams(view: TeamsView): CorrectionTeam[] {
  return view.teams
    .filter((team) => team.status !== "withdrawn")
    .map((team) => ({
      teamKey: team.teamKey,
      name: team.name,
      memberIds: team.members.map((member) => member.participantId),
      captainId: team.members.find((member) => member.role === "captain")?.participantId ?? "",
    }));
}

function memberRole(captainId: string, participantId: string): TeamMemberRole {
  return captainId === participantId ? "captain" : "member";
}

export function TeamsCard({
  activityId,
  permissions,
}: {
  readonly activityId: string;
  readonly permissions: readonly string[];
}) {
  const canManage = permissions.includes("*") || permissions.includes("teams.manage");
  const canCorrect = permissions.includes("*") || permissions.includes("teams.roster.correct");
  const queryClient = useQueryClient();
  const [teamKey, setTeamKey] = useState("");
  const [teamName, setTeamName] = useState("");
  const [rename, setRename] = useState<{ readonly teamId: string; readonly value: string } | null>(null);
  const [memberChoice, setMemberChoice] = useState<Record<string, { participantId: string; role: TeamMemberRole }>>({});
  const [withdrawReason, setWithdrawReason] = useState("");
  const [stageKey, setStageKey] = useState("");
  const [correcting, setCorrecting] = useState<readonly CorrectionTeam[] | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [newCorrectionKey, setNewCorrectionKey] = useState("");
  const [newCorrectionName, setNewCorrectionName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["teams", activityId],
    queryFn: () => fetchTeams(activityId),
    enabled: canManage || canCorrect,
    retry: false,
  });

  const view = query.data;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["teams", activityId] });
  };

  const create = useMutation({
    mutationFn: () => createTeam(activityId, crypto.randomUUID(), {
      teamKey: teamKey.trim(),
      name: teamName.trim(),
    }),
    onSuccess: async () => {
      setTeamKey("");
      setTeamName("");
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "创建队伍失败。", "队伍 key 或名称已被占用。")),
  });

  const renameTeam = useMutation({
    mutationFn: () => {
      if (rename === null) throw new Error("no team selected");
      const team = view?.teams.find((item) => item.id === rename.teamId);
      if (team === undefined) throw new Error("team not found");
      return updateTeam(activityId, team, crypto.randomUUID(), rename.value.trim());
    },
    onSuccess: async () => {
      setRename(null);
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "改名失败。", "队伍已被其他人修改，请刷新后重试。")),
  });

  const addMember = useMutation({
    mutationFn: (team: TeamView) => {
      const choice = memberChoice[team.id] ?? { participantId: "", role: "member" as const };
      if (choice.participantId === "") throw new Error("no participant selected");
      return addTeamMember(activityId, team, crypto.randomUUID(), choice.participantId, choice.role);
    },
    onSuccess: async () => {
      setMemberChoice({});
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "添加队员失败。", "该参与者已在队伍中或人数已满。")),
  });

  const removeMember = useMutation({
    mutationFn: (input: { readonly team: TeamView; readonly participantId: string }) =>
      removeTeamMember(activityId, input.team, input.participantId, crypto.randomUUID()),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "移除队员失败。", "队伍已被修改，请刷新后重试。")),
  });

  const withdraw = useMutation({
    mutationFn: (team: TeamView) => withdrawTeam(activityId, team, withdrawReason.trim(), crypto.randomUUID()),
    onSuccess: async () => {
      setWithdrawReason("");
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "退赛失败。", "队伍已被修改，请刷新后重试。")),
  });

  const freeze = useMutation({
    mutationFn: () => freezeTeamRoster(activityId, crypto.randomUUID()),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "冻结名册失败。", "检查人数、队长或参与者是否仍为已通过。")),
  });

  const importRoster = useMutation({
    mutationFn: () => importTeamsFromGrouping(activityId, stageKey.trim(), crypto.randomUUID()),
    onSuccess: async () => {
      setStageKey("");
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "导入分组失败。", "分组必须已冻结，且当前名册为空。")),
  });

  const correct = useMutation({
    mutationFn: () => {
      if (correcting === null) throw new Error("correction is not open");
      const teams: RosterSpecTeam[] = correcting.map((team) => ({
        teamKey: team.teamKey,
        name: team.name.trim(),
        members: team.memberIds.map((participantId) => ({
          participantId,
          role: memberRole(team.captainId, participantId),
        })),
      }));
      return correctTeamRoster(activityId, crypto.randomUUID(), {
        expectedRosterFingerprint: view?.rosterFingerprint ?? "",
        reason: correctionReason.trim(),
        teams,
      });
    },
    onSuccess: async () => {
      setCorrecting(null);
      setCorrectionReason("");
      setError(null);
      await refresh();
    },
    onError: (caught) => setError(apiErrorText(caught, "修正名册失败。", "名册已被修改或队伍不再满足人数要求。")),
  });

  if (!canManage && !canCorrect) return null;

  const participants = view?.participants ?? [];
  const activeTeams = (view?.teams ?? []).filter((team) => team.status !== "withdrawn");
  const taken = new Set(activeTeams.flatMap((team) => team.members.map((member) => member.participantId)));
  const available = participants.filter((participant) => !taken.has(participant.participantId));
  const canCreate = teamKey.trim() !== "" && teamName.trim() !== "";

  const updateCorrectionTeam = (index: number, patch: Partial<CorrectionTeam>): void => {
    if (correcting === null) return;
    const next = [...correcting];
    const current = next[index];
    if (current === undefined) return;
    next[index] = { ...current, ...patch };
    setCorrecting(next);
  };

  const toggleCorrectionMember = (index: number, participantId: string): void => {
    if (correcting === null) return;
    const current = correcting[index];
    if (current === undefined) return;
    const has = current.memberIds.includes(participantId);
    const memberIds = has
      ? current.memberIds.filter((id) => id !== participantId)
      : [...current.memberIds, participantId];
    updateCorrectionTeam(index, {
      memberIds,
      captainId: current.captainId === participantId && has ? "" : current.captainId,
    });
  };

  return (
    <Card className="teams-card" data-testid="teams-card">
      <h2 className="ui-card__title">队伍与名册</h2>
      {query.error !== null ? (
        <p className="ui-field__error" role="alert">
          {apiErrorText(query.error, "队伍暂时无法加载。", "刷新后重试。")}
        </p>
      ) : null}
      {view === undefined ? null : (
        <>
          <p className="ui-card__description">
            人数 {view.definition.minSize}–{view.definition.maxSize}
            {view.definition.requireCaptain ? " · 每队一名队长" : ""}
            {view.rosterFrozen ? " · 名册已冻结" : ""}
          </p>

          {view.definition.source === "grouping" && activeTeams.length === 0 ? (
            <div className="auth-form">
              <Input label="分组 stage key" value={stageKey} onChange={(event) => setStageKey(event.target.value)} maxLength={100} />
              <Button
                variant="secondary"
                onClick={() => importRoster.mutate()}
                disabled={importRoster.isPending || stageKey.trim() === ""}
              >
                从冻结分组导入
              </Button>
            </div>
          ) : null}

          {canManage && !view.rosterFrozen && view.definition.source === "manual" ? (
            <div className="auth-form">
              <Input label="队伍 key" value={teamKey} onChange={(event) => setTeamKey(event.target.value)} maxLength={40} />
              <Input label="队伍名称" value={teamName} onChange={(event) => setTeamName(event.target.value)} maxLength={80} />
              <Button variant="secondary" onClick={() => create.mutate()} disabled={create.isPending || !canCreate}>
                添加队伍
              </Button>
            </div>
          ) : null}

          {correcting === null ? (
            <ul className="seat-list">
              {view.teams.map((team) => (
                <li key={team.id} data-testid="team-row">
                  {rename !== null && rename.teamId === team.id ? (
                    <>
                      <Input
                        label="队伍名称"
                        value={rename.value}
                        onChange={(event) => setRename({ teamId: team.id, value: event.target.value })}
                        maxLength={80}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => renameTeam.mutate()}
                        disabled={renameTeam.isPending || rename.value.trim() === ""}
                      >
                        保存
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setRename(null)}>取消</Button>
                    </>
                  ) : (
                    <>
                      <strong>{team.name}</strong>
                      <span> · {team.teamKey} · {STATUS_LABELS[team.status]} · {team.members.length} 人</span>
                      {team.withdrawReason === undefined ? null : <span> · 原因：{team.withdrawReason}</span>}
                    </>
                  )}
                  {team.status === "draft" && rename === null ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setRename({ teamId: team.id, value: team.name })}
                    >
                      改名
                    </Button>
                  ) : null}
                  {team.status !== "withdrawn" ? (
                    <>
                      <ul>
                        {team.members.map((member) => (
                          <li key={member.participantId}>
                            {member.name}
                            {member.role === "captain" ? "（队长）" : ""}
                            {team.status === "draft" ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => removeMember.mutate({ team, participantId: member.participantId })}
                                disabled={removeMember.isPending}
                              >
                                移除
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      {team.status === "draft" && available.length > 0 ? (
                        <>
                          <label className="ui-field">
                            <span className="ui-field__label">添加队员</span>
                            <select
                              className="ui-input"
                              value={memberChoice[team.id]?.participantId ?? ""}
                              onChange={(event) => setMemberChoice({
                                ...memberChoice,
                                [team.id]: {
                                  participantId: event.target.value,
                                  role: memberChoice[team.id]?.role ?? "member",
                                },
                              })}
                            >
                              <option value="">选择参与者</option>
                              {available.map((participant) => (
                                <option key={participant.participantId} value={participant.participantId}>
                                  {participant.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="ui-field">
                            <span className="ui-field__label">角色</span>
                            <select
                              className="ui-input"
                              value={memberChoice[team.id]?.role ?? "member"}
                              onChange={(event) => setMemberChoice({
                                ...memberChoice,
                                [team.id]: {
                                  participantId: memberChoice[team.id]?.participantId ?? "",
                                  role: event.target.value === "captain" ? "captain" : "member",
                                },
                              })}
                            >
                              <option value="member">队员</option>
                              <option value="captain">队长</option>
                            </select>
                          </label>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => addMember.mutate(team)}
                            disabled={addMember.isPending || (memberChoice[team.id]?.participantId ?? "") === ""}
                          >
                            添加
                          </Button>
                        </>
                      ) : null}
                      <Input label="退赛原因" value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} maxLength={1000} />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => withdraw.mutate(team)}
                        disabled={withdraw.isPending || withdrawReason.trim() === ""}
                      >
                        标记退赛
                      </Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="auth-form">
              <h3 className="ui-card__title">修正名册</h3>
              {correcting.map((team, index) => (
                <div className="editor-row" key={`${team.teamKey}-${index}`}>
                  <Input
                    label="队伍名称"
                    value={team.name}
                    onChange={(event) => updateCorrectionTeam(index, { name: event.target.value })}
                    maxLength={80}
                  />
                  <span>已选 {team.memberIds.length} 人</span>
                  <ul>
                    {participants.map((participant) => (
                      <li key={participant.participantId}>
                        <label>
                          <input
                            type="checkbox"
                            checked={team.memberIds.includes(participant.participantId)}
                            onChange={() => toggleCorrectionMember(index, participant.participantId)}
                          />
                          {participant.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <label className="ui-field">
                    <span className="ui-field__label">队长</span>
                    <select
                      className="ui-input"
                      value={team.captainId}
                      onChange={(event) => updateCorrectionTeam(index, { captainId: event.target.value })}
                    >
                      <option value="">无</option>
                      {team.memberIds.map((participantId) => (
                        <option key={participantId} value={participantId}>
                          {participants.find((item) => item.participantId === participantId)?.name ?? participantId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setCorrecting(correcting.filter((_, position) => position !== index))}
                  >
                    移除队伍
                  </Button>
                </div>
              ))}
              <Input label="新队伍 key" value={newCorrectionKey} onChange={(event) => setNewCorrectionKey(event.target.value)} maxLength={40} />
              <Input label="新队伍名称" value={newCorrectionName} onChange={(event) => setNewCorrectionName(event.target.value)} maxLength={80} />
              <Button
                variant="secondary"
                onClick={() => {
                  if (newCorrectionKey.trim() === "" || newCorrectionName.trim() === "") return;
                  setCorrecting([
                    ...correcting,
                    {
                      teamKey: newCorrectionKey.trim(),
                      name: newCorrectionName.trim(),
                      memberIds: [],
                      captainId: "",
                    },
                  ]);
                  setNewCorrectionKey("");
                  setNewCorrectionName("");
                }}
              >
                添加队伍
              </Button>
              <Input label="修正原因" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} maxLength={1000} />
              <Button
                variant="secondary"
                onClick={() => correct.mutate()}
                disabled={correct.isPending || correctionReason.trim() === "" || correcting.length === 0}
              >
                保存修正
              </Button>
              <Button variant="secondary" onClick={() => setCorrecting(null)}>取消修正</Button>
            </div>
          )}

          <div className="auth-form">
            {view.rosterFrozen ? (
              canCorrect ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCorrecting(correctionTeams(view));
                    setCorrectionReason("");
                  }}
                >
                  修正名册
                </Button>
              ) : null
            ) : (
              <Button
                variant="secondary"
                onClick={() => freeze.mutate()}
                disabled={freeze.isPending || activeTeams.length === 0}
              >
                冻结名册
              </Button>
            )}
            {view.rosterFrozen ? <span>指纹 {view.rosterFingerprint.slice(0, 12)}</span> : null}
          </div>
        </>
      )}
      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
    </Card>
  );
}
