import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { PublicProfileEditor, type PublicProfileDraft } from "./PublicProfileEditor.js";

const base: PublicProfileDraft = {
  tagline: "",
  description: "",
  venue: "",
  startsAt: "",
  endsAt: "",
  organizer: "",
  contact: "",
  announcement: "",
  announcements: [],
  faq: [],
  links: [],
  participantsVisible: false,
  listedPublicly: false,
};

function Harness() {
  const [draft, setDraft] = useState(base);
  return <PublicProfileEditor draft={draft} onChange={setDraft} disabled={false} />;
}

describe("PublicProfileEditor", () => {
  it("adds and removes announcement, FAQ, and link rows", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "添加公告" }));
    expect(screen.getByLabelText("公告标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除公告" }));
    expect(screen.queryByLabelText("公告标题")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加问题" }));
    expect(screen.getByLabelText("问题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除问题" }));
    expect(screen.queryByLabelText("问题")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加链接" }));
    expect(screen.getByLabelText("链接名称")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除链接" }));
    expect(screen.queryByLabelText("链接名称")).not.toBeInTheDocument();
  });

  it("toggles the participant directory", () => {
    render(<Harness />);
    const checkbox = screen.getByLabelText("公开参与者目录");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("toggles the public directory listing", () => {
    render(<Harness />);
    const checkbox = screen.getByLabelText("列入公开活动目录");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});
