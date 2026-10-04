"""Printable PDF rendition of a stage result, for the host's handcard.

GOAL §2.4 lists PDF among the auxiliary artifacts the system may hand out; the
handcard is the one that actually gets printed, so that is what this module renders.

The Chinese text uses reportlab's Adobe CJK CID font (``STSong-Light``). That font is
deliberately **not embedded**: a viewer substitutes a system CJK face (SimSun on
Windows, which every venue machine that prints the handcard has). Embedding would mean
shipping a multi-megabyte CJK TrueType file in the repository for one auxiliary
document. The trade-off is that the PDF is not self-contained — a renderer with no CJK
font available would show blank glyphs.
"""

from __future__ import annotations

import io
from decimal import Decimal
from typing import Any

from reportlab.lib import colors  # type: ignore[import-untyped]
from reportlab.lib.pagesizes import A4  # type: ignore[import-untyped]
from reportlab.lib.styles import ParagraphStyle  # type: ignore[import-untyped]
from reportlab.lib.units import mm  # type: ignore[import-untyped]
from reportlab.pdfbase import pdfmetrics  # type: ignore[import-untyped]
from reportlab.pdfbase.cidfonts import UnicodeCIDFont  # type: ignore[import-untyped]
from reportlab.platypus import (  # type: ignore[import-untyped]
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

CJK_FONT = "STSong-Light"

# (column header, width in mm) — the widths must fit A4 minus the 18mm side margins.
_COLUMNS: tuple[tuple[str, float], ...] = (
    ("#", 10 * mm),
    ("名次", 14 * mm),
    ("选手", 34 * mm),
    ("曲目", 56 * mm),
    ("得分", 20 * mm),
    ("说明", 40 * mm),
)

_font_registered = False


def _cjk_font() -> str:
    """Register the CID font once per process and return its name."""
    global _font_registered
    if not _font_registered:
        pdfmetrics.registerFont(UnicodeCIDFont(CJK_FONT))
        _font_registered = True
    return CJK_FONT


def _number(value: Any, *, places: int = 2) -> str:
    if value is None:
        return "—"
    if isinstance(value, Decimal | int | float):
        return f"{value:.{places}f}"
    return str(value)


def _table(rows: list[list[str]], font: str) -> Table:
    table = Table(rows, colWidths=[width for _header, width in _COLUMNS], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), font),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#333333")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f2f2f2")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (1, -1), "CENTER"),
                ("ALIGN", (4, 1), (4, -1), "RIGHT"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def render_stage_result_pdf(*, stage: Any, blocks: list[dict[str, Any]]) -> bytes:
    """Render ``stage`` and its handcard ``blocks`` as PDF bytes.

    ``blocks`` is the same ``stage_decisions_by_blocks(stage)`` structure the staff page
    renders, so the page and the PDF can never disagree about what the result is.
    """
    font = _cjk_font()
    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"{stage.stage_key} 主持手卡",
    )

    title_style = ParagraphStyle(
        "handcard-title", fontName=font, fontSize=18, leading=24, spaceAfter=2
    )
    meta_style = ParagraphStyle(
        "handcard-meta",
        fontName=font,
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#555555"),
    )
    block_style = ParagraphStyle(
        "handcard-block", fontName=font, fontSize=12, leading=16, spaceBefore=10, spaceAfter=4
    )

    story: list[Any] = [
        Paragraph(f"{stage.stage_key} · {stage.activity.title}", title_style),
        Paragraph(
            f"主持手卡 · {stage.get_status_display()} · 结果版本 v{stage.result_version}",
            meta_style,
        ),
    ]
    if getattr(stage, "confirmed_at", None) is not None:
        story.append(Paragraph(f"核定时间：{stage.confirmed_at:%Y-%m-%d %H:%M}", meta_style))

    for block in blocks:
        story.append(Paragraph(str(block["label"]), block_style))
        rows = [[header for header, _width in _COLUMNS]]
        for index, decision in enumerate(block["decisions"], start=1):
            rows.append(
                [
                    str(index),
                    "—" if decision.rank is None else str(decision.rank),
                    decision.singer.name,
                    decision.song_label or "—",
                    _number(decision.score),
                    decision.reason or "",
                ]
            )
        story.append(_table(rows, font))

    if len(story) <= 2:
        story.append(Spacer(1, 6))
        story.append(Paragraph("暂无结果条目。", meta_style))

    document.build(story)
    return buffer.getvalue()
