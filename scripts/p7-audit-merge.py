#!/usr/bin/env python3
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

def normalize(page):
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    if abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
    return page

cover = PdfReader('/home/z/my-project/scripts/p7-audit-cover.pdf')
body = PdfReader('/home/z/my-project/scripts/p7-audit-body.pdf')
writer = PdfWriter()
writer.add_page(normalize(cover.pages[0]))
for p in body.pages:
    writer.add_page(normalize(p))
writer.add_metadata({
    '/Title': 'Praveen Garments - Phase 7 Final Production Audit Report',
    '/Author': 'Z.ai',
    '/Creator': 'Z.ai',
    '/Subject': 'Final production audit: bug fixes, 353-check regression, honest verdict',
})
out = '/home/z/my-project/download/Praveen-Garments-Phase7-Final-Audit-Report.pdf'
with open(out, 'wb') as f:
    writer.write(f)
print('MERGED:', out, '| pages:', len(writer.pages))
