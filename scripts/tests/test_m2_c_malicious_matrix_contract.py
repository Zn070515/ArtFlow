from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MATRIX = (REPOSITORY_ROOT / "docs/m2-c-malicious-rehearsal-matrix.md").read_text(encoding="utf-8")
RUNBOOK = (REPOSITORY_ROOT / "docs/production-rehearsal-runbook.md").read_text(encoding="utf-8")
READINESS = (REPOSITORY_ROOT / "docs/production-readiness.md").read_text(encoding="utf-8")


def test_m2_c_matrix_keeps_authority_and_school_attack_families():
    required_sections = (
        "## 2. Authority 与授权绕过矩阵",
        "## 3. 认证、会话、CSRF 与泄露矩阵",
        "## 4. 输入、解析器与属性级授权矩阵",
        "## 5. 工作流、竞态与事实生命周期矩阵",
        "## 6. 资源消耗、自动化滥用与 DDoS 分层矩阵",
        "## 7. 配置、端点库存与供应链矩阵",
        "## 8. 学校接入与身份治理矩阵",
        "## 9. 监测、响应与恢复矩阵",
    )
    for section in required_sections:
        assert section in MATRIX

    for marker in (
        "AUTH-07",
        "AUTH-09",
        "SESS-04",
        "FLOW-04",
        "DOS-08",
        "SCHOOL-01",
        "SCHOOL-03",
        "REC-03",
    ):
        assert marker in MATRIX


def test_m2_c_matrix_preserves_safe_execution_boundaries():
    for phrase in (
        "不得对学校网络、公共域名、第三方服务或未经授权的地址施压",
        "最多 32 个并发客户端",
        "不使用 `docker compose down --volumes`",
        "大流量、真实 WAF/DDoS",
        "仅在批准窗口由边缘/WAF/供应商执行",
    ):
        assert phrase in MATRIX


def test_m2_c_matrix_is_linked_from_both_rehearsal_documents():
    assert "m2-c-malicious-rehearsal-matrix.md" in RUNBOOK
    assert "m2-c-malicious-rehearsal-matrix.md" in READINESS


def test_m2_c_matrix_names_official_security_bases():
    for source in (
        "OWASP API Security Top 10 2023",
        "OWASP Web Security Testing Guide",
        "OWASP ASVS",
        "NIST SP 800-63B",
        "NIST SP 800-61 Rev. 3",
    ):
        assert source in MATRIX
