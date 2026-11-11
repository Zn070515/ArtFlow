import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startStudioSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/studio.js", () => ({
  startStudioSession: startStudioSessionMock,
  closeStudioSession: vi.fn(),
}));

import type { StudioState } from "../../api/studio.js";
import { SessionPanel } from "./SessionPanel.js";

const state = {
  activity: {
    id: "activity-1",
    publicCode: "NLDC99ZM",
    title: "春季现场",
    status: "active",
    revision: 1,
    enabledCapabilities: ["registration"],
    activeDefinitionVersion: 1,
  },
  draft: null,
  compiled: null,
  releases: [
    {
      version: 1,
      contentHash: "hash",
      releasedAt: "2026-11-11T10:00:00.000Z",
      sourceDraftRevision: 1,
      declaredScopes: ["checkin", "judging"],
      capabilityVersions: {},
      active: true,
    },
  ],
  sessions: [],
} as unknown as StudioState;

describe("SessionPanel", () => {
  beforeEach(() => {
    startStudioSessionMock.mockReset();
    startStudioSessionMock.mockResolvedValue(undefined);
  });

  it("defaults to the least consequential test mode", () => {
    render(<SessionPanel state={state} onChanged={vi.fn()} />);

    expect(screen.getByLabelText("Mode")).toHaveValue("test");
  });

  it("requires an explicit confirmation that names the scope and mode", () => {
    render(<SessionPanel state={state} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "formal" } });
    fireEvent.click(screen.getByRole("button", { name: "启动会话" }));

    expect(startStudioSessionMock).not.toHaveBeenCalled();
    expect(screen.getByText(/将启动 checkin · formal 会话/)).toBeInTheDocument();
    expect(screen.getByText(/不能当作彩排重复运行/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认启动 formal 会话" }));
    expect(startStudioSessionMock).toHaveBeenCalledWith(
      "activity-1",
      expect.any(String),
      "checkin",
      "formal",
    );
  });
});
