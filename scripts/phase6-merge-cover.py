#!/usr/bin/env python3
"""Merge Phase 6 report: cover (page 0) + body -> final PDF, normalized to A4."""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

COVER = "/home/z/my-project/download/phase6-cover.pdf"
BODY = "/home/z/my-project/download/phase6-body.pdf"
OUT = "/home/z/my-project/download/Praveen-Garments-Phase6-Final-Audit-Report.pdf"


def normalize_page_to_a4(page, force=False):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if force or abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
        page.mediabox.lower_left = (0, 0)
        page.mediabox.upper_right = (A4_W, A4_H)
    return page


writer = PdfWriter()
cover_page = PdfReader(COVER).pages[0]
writer.add_page(normalize_page_to_a4(cover_page, force=True))
for page in PdfReader(BODY).pages:
    writer.add_page(normalize_page_to_a4(page))
writer.add_metadata({
    "/Title": "Praveen Garments POS - Phase 6 Production Audit - Final Report",
    "/Author": "Z.ai",
    "/Creator": "Z.ai",
    "/Subject": "Deep end-to-end production audit of the Praveen Garments POS system",
})
with open(OUT, "wb") as f:
    writer.write(f)
print("MERGED OK:", OUT, "| pages:", len(writer.pages))
