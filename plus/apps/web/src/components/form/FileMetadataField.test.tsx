import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileMetadataField } from "./FileMetadataField.js";

const question = {
  key: "audio",
  label: "音频材料",
  type: "file" as const,
  required: true,
  file: { slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1024 },
};

describe("FileMetadataField", () => {
  it("says the bytes are saved after content is stored", () => {
    render(
      <FileMetadataField
        question={question}
        material={{
          id: "material-1",
          questionKey: "audio",
          originalName: "demo.mp3",
          contentType: "audio/mpeg",
          byteLength: 2048,
          status: "uploaded",
          revision: 1,
          contentReady: true,
        }}
        disabled={false}
        busy={false}
        onFile={vi.fn()}
      />,
    );
    expect(screen.getByText(/字节已保存：demo\.mp3/)).toBeInTheDocument();
    expect(screen.queryByText(/仅登记文件信息/)).not.toBeInTheDocument();
  });

  it("keeps the metadata warning until the bytes are stored", () => {
    render(
      <FileMetadataField
        question={question}
        material={{
          id: "material-1",
          questionKey: "audio",
          originalName: "demo.mp3",
          contentType: "audio/mpeg",
          byteLength: 17,
          status: "uploaded",
          revision: 0,
          contentReady: false,
        }}
        disabled={false}
        busy={false}
        onFile={vi.fn()}
      />,
    );
    expect(screen.getByText(/仅登记文件信息/)).toBeInTheDocument();
  });
});
