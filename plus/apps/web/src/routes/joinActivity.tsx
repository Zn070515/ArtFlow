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

function RegistrationNotFoundState({ publicCode }: { readonly publicCode: string }) {
  return (
    <section className="console-state">
      <p className="eyebrow">REGISTRATION</p>
      <h1 className="console-page-title">没有找到这场活动</h1>
      <p className="state-copy">公开码「{publicCode}」不存在，或报名尚未开放。</p>
    </section>
  );
}

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

  if (publicQuery.isPending) return <p className="console-state auth-loading">正在加载活动…</p>;
  if (publicQuery.error instanceof ApiError && publicQuery.error.status === 404) {
    return <RegistrationNotFoundState publicCode={publicCode} />;
  }
  if (publicQuery.error !== null) {
    return <p className="console-state form-error" role="alert">活动暂时无法加载，请稍后重试。</p>;
  }
  if (activity === undefined) return <p className="console-state auth-loading">正在加载活动…</p>;
  if (!activity.registrationOpen) {
    return (
      <section className="console-state">
        <p className="eyebrow">REGISTRATION</p>
        <h1 className="console-page-title">{activity.title}的报名尚未开放</h1>
        <p className="state-copy">活动开始报名后再回来。</p>
      </section>
    );
  }
  if (startMutation.error !== null && registrationId === undefined) {
    const message =
      startMutation.error instanceof ApiError ? startMutation.error.message : "报名初始化失败，请稍后重试。";
    return <p className="console-state form-error" role="alert">{message}</p>;
  }
  if (registrationId === undefined) return <p className="console-state auth-loading">正在准备报名…</p>;
  if (detailQuery.isPending) return <p className="console-state auth-loading">正在加载报名表…</p>;
  if (detailQuery.error !== null) {
    return <p className="console-state form-error" role="alert">报名表暂时无法加载，请稍后重试。</p>;
  }
  if (detailQuery.data === undefined) return <p className="console-state auth-loading">正在加载报名表…</p>;

  return (
    <section className="registration-page">
      <header className="console-page-header">
        <div>
          <p className="eyebrow">REGISTRATION · 报名</p>
          <h1 className="console-page-title">{activity.title}</h1>
          <p className="state-copy">公开码 {activity.publicCode} · 参与者 {detailQuery.data.registration.participantId}</p>
        </div>
      </header>
      <RegistrationForm
        detail={detailQuery.data}
        showHeader={false}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["registration-detail", activity.id, registrationId] });
          void queryClient.invalidateQueries({ queryKey: ["registration-mine", activity.id] });
        }}
      />
    </section>
  );
}
