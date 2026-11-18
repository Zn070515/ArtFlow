import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: "spring-recap" }),
  Link: ({ children }: { readonly children: ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock("../api/articles.js", () => ({
  fetchPublicArticle: vi.fn(async () => ({
    slug: "spring-recap",
    title: "春季回顾",
    summary: "一晚的歌",
    body: "第一段。\n\n第二段。",
    publishedAt: "2026-11-18T12:00:00.000Z",
  })),
}));

import { ArticlePage } from "./article.js";

describe("ArticlePage", () => {
  it("renders the published body", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ArticlePage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("春季回顾")).toBeInTheDocument();
    expect(screen.getByText(/第二段/)).toBeInTheDocument();
  });
});
