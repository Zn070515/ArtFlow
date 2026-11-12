import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Table } from "./Table.js";
import { Toolbar } from "./Toolbar.js";

describe("Table and Toolbar", () => {
  it("wraps a table in the overflow container and keeps an accessible caption", () => {
    render(
      <Table caption="活动列表">
        <thead><tr><th scope="col">活动</th></tr></thead>
        <tbody><tr><td data-label="活动">春季歌手赛</td></tr></tbody>
      </Table>,
    );
    expect(screen.getByRole("table", { name: "活动列表" })).toHaveClass("ui-table");
    expect(document.querySelector(".ui-table-wrap")).not.toBeNull();
  });

  it("renders a labelled toolbar", () => {
    render(<Toolbar label="活动筛选"><input aria-label="搜索" /></Toolbar>);
    expect(screen.getByRole("search", { name: "活动筛选" })).toHaveClass("ui-toolbar");
  });
});
