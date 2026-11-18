import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../../api/studio.js", () => ({
  createStudioActivity: createMock,
  previewPack: vi.fn(),
}));

import { ApiError } from "../../api/client.js";
import { StudioWizard } from "./StudioWizard.js";

const packs = [
  {
    identity: "singer-competition",
    version: "1",
    title: "Singer",
    baselineCapabilities: ["competition"],
    questions: [
      { id: "registration-required", prompt: "需要报名", capability: "registration", default: true },
      { id: "judge-entry", prompt: "需要评委入口", capability: "ticketing", default: true },
    ],
  },
  {
    identity: "stage-show",
    version: "1",
    title: "Stage",
    baselineCapabilities: ["schedule"],
    questions: [],
  },
];

function previewData() {
  return {
    data: {
      pack: { identity: "singer-competition", version: "1" },
      enabledCapabilities: ["competition", "registration"],
      definition: {},
    },
    error: null,
    isPending: false,
  };
}

function next(): void {
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
}

describe("StudioWizard", () => {
  beforeEach(() => {
    useQueryMock.mockReturnValue(previewData());
    createMock.mockResolvedValue({ id: "act-1" });
    navigateMock.mockReset();
  });

  it("moves through the steps and creates with the current answers", async () => {
    render(<StudioWizard packs={packs} />);
    next();
    fireEvent.change(screen.getByLabelText("活动标题"), { target: { value: "春季赛" } });
    next();
    next();
    next();
    next();
    expect(screen.getByRole("heading", { name: "检查与创建" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建活动" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "春季赛", packId: "singer-competition" }),
    ));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/studio/$activityId",
      params: { activityId: "act-1" },
    });
  });

  it("resets answers when the pack changes", async () => {
    render(<StudioWizard packs={packs} />);
    fireEvent.click(screen.getByRole("button", { name: /舞台演出/ }));
    await waitFor(() => {
      const lastCall = useQueryMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({
        queryKey: ["pack-preview", "stage-show", "", {}],
      });
    });
  });

  it("disables create on a preview error", async () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      error: new ApiError(422, "PACK_COMPOSITION_INVALID", "invalid", [
        { code: "X", message: "bad", path: "p" },
      ]),
      isPending: false,
    });
    render(<StudioWizard packs={packs} />);
    next();
    fireEvent.change(screen.getByLabelText("活动标题"), { target: { value: "春季赛" } });
    next();
    next();
    next();
    next();
    expect(screen.getByText(/bad/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建活动" })).toBeDisabled();
  });
});
