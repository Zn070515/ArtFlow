import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useMutationMock = vi.hoisted(() => vi.fn());
const useQueryMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({ useParams: useParamsMock }));
vi.mock("../api/client.js", () => ({ ApiError: class ApiError extends Error { readonly status = 500; } }));
vi.mock("../api/registrations.js", () => ({
  fetchMyRegistration: vi.fn(),
  fetchPublicActivity: vi.fn(),
  fetchRegistrationDetail: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/form/RegistrationForm.js", () => ({
  RegistrationForm: () => <div data-testid="registration-form">报名表</div>,
}));
vi.mock("../components/results/ResultStates.js", () => ({
  NotFoundState: () => <div>未找到活动</div>,
}));

import { JoinActivityPage } from "./joinActivity.js";

describe("JoinActivityPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ publicCode: "SPRING-1" });
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    useMutationMock.mockReturnValue({ data: undefined, error: null, mutate: vi.fn() });
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      if (queryKey[0] === "public-activity") {
        return {
          data: {
            id: "activity-1",
            publicCode: "SPRING-1",
            title: "春季现场",
            status: "active",
            registrationOpen: true,
          },
          error: null,
          isPending: false,
        };
      }
      if (queryKey[0] === "registration-mine") {
        return {
          data: {
            id: "registration-1",
            activityId: "activity-1",
            participantId: "participant-1",
            questionnaireVersion: "v1",
            questionnaireHash: "hash-1",
            status: "draft",
            answers: {},
            revision: 1,
          },
          error: null,
          isPending: false,
          isSuccess: true,
        };
      }
      return {
        data: {
          activity: { id: "activity-1", title: "春季现场", status: "active", publicCode: "SPRING-1" },
          registration: {
            id: "registration-1",
            activityId: "activity-1",
            participantId: "participant-1",
            questionnaireVersion: "v1",
            questionnaireHash: "hash-1",
            status: "draft",
            answers: {},
            revision: 1,
          },
          questionnaire: { version: "v1", questions: [], fileSlots: [] },
          materials: [],
        },
        error: null,
        isPending: false,
      };
    });
  });

  it("uses a Console registration page header", () => {
    render(<JoinActivityPage />);

    expect(document.querySelector(".registration-page")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
    expect(screen.getByTestId("registration-form")).toBeInTheDocument();
  });
});
