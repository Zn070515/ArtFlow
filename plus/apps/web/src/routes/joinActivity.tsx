import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { ApiError } from "../api/client.js";
import {
  fetchMyRegistration,
  fetchPublicActivity,
  fetchRegistrationDetail,
  startRegistration,
} from "../api/registrations.js";
import { RequireSession } from "../auth/RequireSession.js";
import { RegistrationForm } from "../components/form/RegistrationForm.js";
import { NotFoundState } from "../components/results/ResultStates.js";

export function JoinActivityPage() {
  return (
    <RequireSession>
      <JoinActivityContent />
    </RequireSession>
  );
}

function JoinActivityContent() {
  const { publicCode } = useParams({ from: "/join/$publicCode" });
  const queryClient = useQueryClient();
  const started = useRef(false);
  const commandId = useRef(crypto.randomUUID());

  const publicQuery = useQuery({
    queryKey: ["public-activity", publicCode],
    queryFn: () => fetchPublicActivity(publicCode),
    retry: false,
  });
  const activity = publicQuery.data;

  const mineQuery = useQuery({
    queryKey: ["registration-mine", activity?.id],
    queryFn: () => fetchMyRegistration(activity?.id ?? ""),
    enabled: activity !== undefined && activity.registrationOpen,
    retry: false,
  });

  const startMutation = useMutation({
    mutationFn: () => startRegistration(activity?.id ?? "", commandId.current),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["registration-mine", activity?.id] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "INVALID_TRANSITION") {
        void queryClient.invalidateQueries({ queryKey: ["registration-mine", activity?.id] });
      }
    },
  });

  useEffect(() => {
    if (activity === undefined || !activity.registrationOpen) return;
    if (!mineQuery.isSuccess || mineQuery.data !== null) return;
    if (started.current) return;
    started.current = true;
    startMutation.mutate();
  }, [activity, mineQuery.isSuccess, mineQuery.data, startMutation]);

  const registrationId = mineQuery.data?.id ?? startMutation.data?.id;

  const detailQuery = useQuery({
    queryKey: ["registration-detail", activity?.id, registrationId],
    queryFn: () => fetchRegistrationDetail(activity?.id ?? "", registrationId ?? ""),
    enabled: activity !== undefined && registrationId !== undefined,
    retry: false,
  });

  if (publicQuery.isPending) return <p className="auth-loading">正在加载活动…</p>;
  if (publicQuery.error instanceof ApiError && publicQuery.error.status === 404) {
    return <NotFoundState publicCode={publicCode} />;
  }
  if (publicQuery.error !== null) {
    return <p className="form-error" role="alert">活动暂时无法加载，请稍后重试。</p>;
  }
  if (activity === undefined) return <p className="auth-loading">正在加载活动…</p>;
  if (!activity.registrationOpen) {
    return (
      <section className="result-state">
        <p className="eyebrow">REGISTRATION</p>
        <h1 className="state-title">{activity.title}的报名尚未开放</h1>
        <p className="state-copy">活动开始报名后再回来。</p>
      </section>
    );
  }
  if (startMutation.error !== null && registrationId === undefined) {
    const message =
      startMutation.error instanceof ApiError ? startMutation.error.message : "报名初始化失败，请稍后重试。";
    return <p className="form-error" role="alert">{message}</p>;
  }
  if (registrationId === undefined) return <p className="auth-loading">正在准备报名…</p>;
  if (detailQuery.isPending) return <p className="auth-loading">正在加载报名表…</p>;
  if (detailQuery.error !== null) {
    return <p className="form-error" role="alert">报名表暂时无法加载，请稍后重试。</p>;
  }
  if (detailQuery.data === undefined) return <p className="auth-loading">正在加载报名表…</p>;

  return (
    <RegistrationForm
      detail={detailQuery.data}
      onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: ["registration-detail", activity.id, registrationId] });
        void queryClient.invalidateQueries({ queryKey: ["registration-mine", activity.id] });
      }}
    />
  );
}
