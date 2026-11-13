import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const editPublicationMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/voting.js", () => ({
  editPublication: editPublicationMock,
}));

import { PublicationEditor } from "./PublicationEditor.js";

function renderEditor(
  publication: {
    id: string;
    stageKey: string;
    title: string;
    content: string;
    version: number;
    revision: number;
  } | undefined,
  canManage = true,
): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PublicationEditor
        activityId="activity-1"
        stageKey="final"
        publication={publication}
        canManage={canManage}
        scope="publishing"
        onSaved={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("PublicationEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves an existing publication with its expected version", async () => {
    editPublicationMock.mockResolvedValue({});
    renderEditor({
      id: "publication-1",
      stageKey: "final",
      title: "决赛结果",
      content: "冠军：甲",
      version: 3,
      revision: 2,
    });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "决赛公示" } });
    fireEvent.click(screen.getByRole("button", { name: "保存公示" }));
    await waitFor(() => expect(editPublicationMock).toHaveBeenCalledWith("activity-1", "final", {
      scope: "publishing",
      expectedVersion: 3,
      title: "决赛公示",
      content: "冠军：甲",
    }));
  });

  it("creates the first publication at version zero", async () => {
    editPublicationMock.mockResolvedValue({});
    renderEditor(undefined);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "首次公示" } });
    fireEvent.click(screen.getByRole("button", { name: "保存公示" }));
    await waitFor(() => expect(editPublicationMock).toHaveBeenCalledWith("activity-1", "final", {
      scope: "publishing",
      expectedVersion: 0,
      title: "首次公示",
      content: "",
    }));
  });
});
