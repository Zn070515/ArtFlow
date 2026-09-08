from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_school_onboarding_covers_data_ownership_and_external_boundaries():
    content = (ROOT / "docs" / "school-onboarding.md").read_text(encoding="utf-8")

    for term in (
        "学生/报名",
        "评委描述",
        "QR/grant/session 派生值",
        "成绩与 panel 快照",
        "审计/IP/request 元数据",
        "私有文件",
        "备份/导出",
        "(issuer, subject)",
        "MFA",
        "WAF",
        "DDoS",
        "RTO/RPO",
    ):
        assert term in content


def test_incident_response_covers_non_secret_evidence_and_paper_dr():
    content = (ROOT / "docs" / "incident-response.md").read_text(encoding="utf-8")

    for term in (
        "request ID",
        "payload hash",
        "before/after",
        "纸面评分",
        "原始 token",
        "隔离目标",
        "RTO/RPO",
    ):
        assert term in content
