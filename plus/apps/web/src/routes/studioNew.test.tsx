import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => useNavigateMock }));
vi.mock("../api/studio.js", () => ({
  createStudioActivity: vi.fn(),
  fetchPacks: vi.fn(),
  previewPack: vi.fn(),
}));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasStudioAccess: () => true,
  useSession: useSessionMock,
}));

import { StudioNewPage } from "./studioNew.js";

const packs = [
  {
    identity: "singer-competition",
    version: "1",
    title: "Singer Pack",
    baselineCapabilities: ["registration"],
    questions: [
      { id: "registration-required", prompt: "需要报名", capability: "registration", default: true },
    ],
  },
];

describe("StudioNewPage", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["studio.manage"], roles: [] } } });
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      if (queryKey[0] === "packs") {
        return { data: packs, error: null, isPending: false };
      }
      return {
        data: {
          pack: { identity: "singer-competition", version: "1" },
          enabledCapabilities: ["registration"],
          definition: {},
        },
        error: null,
        isPending: false,
      };
    });
  });

  it("renders the guided wizard on the first step", () => {
    render(<StudioNewPage />);

    expect(screen.getByRole("heading", { name: "选择模板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /歌手比赛/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeInTheDocument();
  });
});
