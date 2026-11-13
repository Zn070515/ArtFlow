import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const claimSupplementMock = vi.hoisted(() => vi.fn());
const fetchSupplementContextMock = vi.hoisted(() => vi.fn());
const uploadSupplementMaterialMock = vi.hoisted(() => vi.fn());
const submitSupplementMock = vi.hoisted(() => vi.fn());
const useSearchMock = vi.hoisted(() => vi.fn());

vi.mock("../api/supplement.js", () => ({
  claimSupplement: claimSupplementMock,
  fetchSupplementContext: fetchSupplementContextMock,
  uploadSupplementMaterial: uploadSupplementMaterialMock,
  submitSupplement: submitSupplementMock,
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: useSearchMock,
}));

import { SupplementPage } from "./supplement.js";

const context = {
  activity: { publicCode: "SING01", title: "春季歌手赛" },
  registrationId: "registration-1",
  status: "need_supplement",
  allowedKeys: ["audio"],
  checks: [{
    slotKey: "audio",
    itemName: "伴奏",
    purpose: "伴奏",
    status: "needs_supplement",
    required: true,
    reviewNote: "请重新上传",
  }],
  materials: [{
    id: "material-1",
    questionKey: "audio",
    originalName: "old.mp3",
    contentReady: true,
  }],
};

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SupplementPage />
    </QueryClientProvider>,
  );
}

describe("SupplementPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSearchMock.mockReturnValue({ token: "supplement-token" });
    claimSupplementMock.mockResolvedValue(context);
    submitSupplementMock.mockResolvedValue({});
  });

  it("claims the token on load and shows only the allowed slot", async () => {
    renderPage();
    expect(await screen.findByTestId("supplement-page")).toBeInTheDocument();
    expect(claimSupplementMock).toHaveBeenCalledWith("supplement-token");
    expect(screen.getByText(/旧.mp3|old\.mp3/)).toBeInTheDocument();
    expect(screen.getByText(/请重新上传/)).toBeInTheDocument();
    expect(screen.getByLabelText("上传 伴奏")).toBeInTheDocument();
  });

  it("falls back to the supplement cookie when no token is present", async () => {
    useSearchMock.mockReturnValue({});
    fetchSupplementContextMock.mockResolvedValue(context);
    renderPage();
    await screen.findByTestId("supplement-page");
    await waitFor(() => expect(fetchSupplementContextMock).toHaveBeenCalled());
    expect(claimSupplementMock).not.toHaveBeenCalled();
  });
});
