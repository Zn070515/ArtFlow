import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NowNextCard } from "./NowNextCard.js";

describe("NowNextCard", () => {
  it("renders the current performance, next entries and freshness", () => {
    render(
      <NowNextCard
        current={{ order: 2, slotLabel: "《起风了》", title: "周然", note: "", startsAt: null }}
        next={[{ order: 3, slotLabel: "《晴天》", title: "陈默", note: "", startsAt: null }]}
        total={3}
        updatedAt={Date.now()}
        onRefresh={() => undefined}
        refreshing={false}
      />,
    );

    expect(screen.getByText("周然")).toBeInTheDocument();
    expect(screen.getByText("《起风了》")).toBeInTheDocument();
    expect(screen.getByText("下一个：陈默")).toBeInTheDocument();
    expect(screen.getByText("刚刚更新")).toBeInTheDocument();
    expect(screen.getByText(/NOW · 02 \/ 3/)).toBeInTheDocument();
  });

  it("asks for a refresh without pretending the data is fresh", () => {
    const onRefresh = vi.fn();
    render(
      <NowNextCard
        current={{ order: 1, slotLabel: "", title: "林晓", note: "", startsAt: null }}
        next={[]}
        total={null}
        updatedAt={undefined}
        onRefresh={onRefresh}
        refreshing={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/更新/)).not.toBeInTheDocument();
  });
});
