import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useParams: useParamsMock,
}));

vi.mock("../api/registrations.js", () => ({
  fetchRegistrationDetail: vi.fn(),
}));

vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("../auth/SessionProvider.js", () => ({
  hasOpsAccess: () => true,
  useSession: useSessionMock,
}));

vi.mock("../components/ops/ReviewPanel.js", () => ({ ReviewPanel: () => <section>审核</section> }));

import { OpsRegistrationPage } from "./opsRegistration.js";

describe("OpsRegistrationPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ activityId: "activity-1", registrationId: "registration-1" });
    useSessionMock.mockReturnValue({
      session: { actor: { permissions: ["*"], roles: ["staff"] } },
    });
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    useQueryMock.mockReturnValue({
      data: {
        activity: {
          id: "activity-1",
          title: "春季现场",
          publicCode: "SPRING-1",
          status: "draft",
        },
        registration: {
          id: "registration-1",
          activityId: "activity-1",
          participantId: "participant:1",
          questionnaireVersion: "v1",
          questionnaireHash: "hash",
          status: "submitted",
          answers: { name: "选手一" },
          revision: 1,
          reviewNote: "",
        },
        questionnaire: {
          version: "v1",
          questions: [{ key: "name", label: "姓名", type: "text", required: true }],
          fileSlots: [],
        },
        materials: [],
      },
      error: null,
      isPending: false,
    });
  });

  it("uses a Console page header instead of a Portal display title", () => {
    render(<OpsRegistrationPage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
    expect(screen.getByRole("heading", { name: "报名信息" })).toHaveClass("console-card-title");
    expect(document.querySelector(".review-note")).toBeNull();
  });

  it("plays a stored audition through the controlled material API", () => {
    useQueryMock.mockReturnValue({
      data: {
        activity: {
          id: "activity-1",
          title: "春季现场",
          publicCode: "SPRING-1",
          status: "active",
        },
        registration: {
          id: "registration-1",
          activityId: "activity-1",
          participantId: "participant:1",
          questionnaireVersion: "v1",
          questionnaireHash: "hash",
          status: "submitted",
          answers: { name: "林晓雨" },
          revision: 1,
          reviewNote: "",
        },
        questionnaire: {
          version: "v1",
          questions: [{
            key: "audio",
            label: "试唱/伴奏音频",
            type: "file",
            required: true,
            file: { slot: "audio", purpose: "audio", accepts: [".mp3"] },
          }],
          fileSlots: [],
        },
        materials: [{
          id: "material-1",
          questionKey: "audio",
          originalName: "夜空中最亮的星.mp3",
          contentType: "audio/mpeg",
          byteLength: 128,
          status: "uploaded",
          revision: 1,
          contentReady: true,
        }],
      },
      error: null,
      isPending: false,
    });

    render(<OpsRegistrationPage />);

    const player = screen.getByLabelText("试听 夜空中最亮的星.mp3");
    expect(player).toHaveAttribute("src", "/api/activities/activity-1/materials/material-1/content");
    expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute(
      "href",
      "/api/activities/activity-1/materials/material-1/content",
    );
    expect(screen.queryByText(/仅元数据/)).not.toBeInTheDocument();
  });
});
