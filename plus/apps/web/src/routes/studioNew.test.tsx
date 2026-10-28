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

describe("StudioNewPage", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["studio.manage"], roles: [] } } });
    useQueryMock.mockReturnValue({
      data: [
        {
          identity: "singer",
          version: "1",
          title: "Singer Pack",
          baselineCapabilities: ["registration"],
          questions: [],
        },
      ],
      error: null,
      isPending: false,
    });
  });

  it("uses the compact Console heading", () => {
    render(<StudioNewPage />);

    expect(screen.getByRole("heading", { name: "新建活动" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "新建活动" })).not.toHaveClass("results-title");
  });
});
