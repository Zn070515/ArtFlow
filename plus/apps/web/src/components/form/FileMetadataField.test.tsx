import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileMetadataField } from "./FileMetadataField.js";

describe("FileMetadataField", () => {
  it("shows registered metadata and the metadata-only warning", () => {
    render(
      <FileMetadataField
        question={{
          key: "audio",
          label: "音频材料",
          type: "file",
          required: true,
          file: { slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1024 },
        }}
        material={{
          id: "material-1",
          questionKey: "audio",
          originalName: "demo.mp3",
          contentType: "audio/mpeg",
          byteLength: 2048,
          status: "uploaded",
          revision: 0,
        }}
        disabled={false}
        busy={false}
        onFile={vi.fn()}
      />,
    );
    expect(screen.getByText(/demo\.mp3/)).toBeInTheDocument();
    expect(screen.getByText(/仅登记文件信息/)).toBeInTheDocument();
  });
});
