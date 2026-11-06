import { useMutation, useQueryClient } from "@tanstack/react-query";

import { finalizeRoster, type OpsRoster } from "../../api/ops.js";

export function RosterCard({
  activityId,
  roster,
}: {
  readonly activityId: string;
  readonly roster: OpsRoster;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => finalizeRoster(activityId, crypto.randomUUID(), roster.revision),
    onSuccess: (saved) => {
      queryClient.setQueryData(["ops-roster", activityId], saved);
      void queryClient.invalidateQueries({ queryKey: ["ops-registrations", activityId] });
    },
  });

  return (
    <section className="ops-card">
      <p className="eyebrow">ROSTER · 名单</p>
      <h2>名单状态</h2>
      {roster.status === "final" ? (
        <p className="state-copy">
          已定稿 · {roster.approvedCount} 人 ·{" "}
          {new Date(roster.finalizedAt).toLocaleString("zh-CN")}
        </p>
      ) : (
        <>
          <p className="state-copy">尚未定稿。定稿后将锁定通过名单。</p>
          <button
            className="primary-button"
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "正在定稿…" : "定稿名单"}
          </button>
        </>
      )}
      {mutation.error === null ? null : (
        <p className="form-error" role="alert">
          {mutation.error instanceof Error ? mutation.error.message : "定稿失败，请稍后重试"}
        </p>
      )}
    </section>
  );
}
