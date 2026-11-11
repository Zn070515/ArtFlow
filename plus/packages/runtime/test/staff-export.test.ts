import { describe, expect, it } from "vitest";

import {
  buildMaterialSheet,
  buildRegistrationSheet,
  buildScoreSheet,
  buildVoteSheet,
  renderSpreadsheet,
} from "../src/staff-export.js";

const registration = {
  id: "reg-1",
  activityId: "act-1",
  participantId: "participant-1",
  questionnaireVersion: "v1",
  questionnaireHash: "hash",
  status: "approved" as const,
  answers: {
    name: "李明",
    student_id: "20260001",
    song: "夜空中最亮的星",
  },
  revision: 2,
  reviewNote: "通过",
};

describe("staff export sheets", () => {
  it("writes an explicit file for an empty, unfinalized roster", () => {
    const sheet = buildRegistrationSheet("unknown", []);
    const csv = renderSpreadsheet(sheet.rows);
    expect(sheet.rowCount).toBe(0);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("名单状态,姓名,学号,曲目,状态,参与者,审核意见");
    expect(csv).toContain("未定稿,（暂无报名）");
  });

  it("includes name, student id, title and status, and neutralizes formulas", () => {
    const sheet = buildRegistrationSheet("final", [{
      ...registration,
      answers: { ...registration.answers, name: "=1+1" },
    }]);
    const csv = renderSpreadsheet(sheet.rows);
    expect(csv).toContain("已定稿,'=1+1,20260001,夜空中最亮的星,已通过,participant-1,通过");
    expect(csv).not.toMatch(/(^|,)=1\+1/);
    expect(csv).not.toContain("（暂无报名）");
  });

  it("uses the programme title when the registration has no song", () => {
    const sheet = buildRegistrationSheet("unknown", [{
      ...registration,
      answers: { name: "王可", program: "合唱《毕业歌》" },
    }]);
    expect(renderSpreadsheet(sheet.rows)).toContain("王可,,合唱《毕业歌》,已通过");
  });

  it("lists material metadata and never receives a storage key", () => {
    const sheet = buildMaterialSheet("unknown", [registration], [{
      registrationId: "reg-1",
      questionKey: "audio",
      originalName: "demo.mp3",
      contentType: "audio/mpeg",
      byteLength: 12,
      status: "uploaded",
    }]);
    const csv = renderSpreadsheet(sheet.rows);
    expect(csv).toContain("李明,20260001,audio,demo.mp3,audio/mpeg,12,已上传");
    expect(csv).not.toContain("storage");
    expect(buildMaterialSheet("final", [], []).rows[1]?.[1]).toBe("（暂无材料）");
  });

  it("quotes formula-like material names", () => {
    const sheet = buildMaterialSheet("final", [registration], [{
      registrationId: "reg-1",
      questionKey: "audio",
      originalName: '=HYPERLINK("http://evil","x")',
      contentType: "audio/mpeg",
      byteLength: 1,
      status: "approved",
    }]);
    expect(renderSpreadsheet(sheet.rows)).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });

  it("writes explicit score and vote files when nothing has been recorded", () => {
    expect(renderSpreadsheet(buildScoreSheet([]).rows)).toContain("（暂无评分）");
    expect(renderSpreadsheet(buildVoteSheet([]).rows)).toContain("（暂无投票场次）");
    const votes = renderSpreadsheet(buildVoteSheet([{
      sessionId: "session-1",
      mode: "formal",
      status: "closed",
      candidateId: "singer-a",
      ordinal: 0,
      count: 3,
      totalBallots: 3,
    }]).rows);
    expect(votes).toContain("session-1,formal,closed,singer-a,0,3,3");
  });
});
