import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children: ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock("../api/articles.js", () => ({
  fetchPublicArticles: vi.fn(async () => [{
    slug: "spring-recap",
    title: "春季回顾",
    summary: "一晚的歌",
    publishedAt: "2026-11-18T12:00:00.000Z",
  }]),
}));

import { ArticlesPage } from "./articles.js";

describe("ArticlesPage", () => {
  it("lists published stories", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ArticlesPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("春季回顾")).toBeInTheDocument();
    expect(screen.getByText("一晚的歌")).toBeInTheDocument();
    expect(screen.getByText("文章与往届风采")).toBeInTheDocument();
  });
});
