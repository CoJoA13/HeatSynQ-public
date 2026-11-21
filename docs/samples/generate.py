#!/usr/bin/env python3
"""Rebuild project-owned fictional reference PDFs with ReportLab; no private inputs."""
from pathlib import Path
import argparse
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
font_root = Path(__file__).resolve().parents[2] / 'erp/src/server/pdf/fonts/liberation-sans'
for style, suffix in [('SampleSans', 'Regular'), ('SampleSans-Bold', 'Bold')]:
    pdfmetrics.registerFont(TTFont(style, str(font_root / f'LiberationSans-{suffix}.ttf')))

INK = HexColor('#17324d')
LIGHT = HexColor('#eef3f7')
MUTED = HexColor('#526577')
WIDTH, HEIGHT = letter

def text(c, x, y, value, size=10, bold=False, color=INK):
    c.setFillColor(color)
    c.setFont('SampleSans-Bold' if bold else 'SampleSans', size)
    c.drawString(x, y, value)

def block(c, y, title, rows):
    c.setFillColor(LIGHT)
    c.rect(42, y - 22, 528, 23, fill=1, stroke=0)
    text(c, 52, y - 15, title.upper(), 9, True)
    y -= 44
    for label, value in rows:
        text(c, 52, y, label, 9, True)
        text(c, 218, y, value, 10)
        y -= 23
    return y - 12

def make(filename, title, number, sections):
    c = canvas.Canvas(str(args.output / filename), pagesize=letter, invariant=1,
                      pageCompression=1)
    c.setTitle(f'HeatSynQ fictional example - {title}')
    c.setAuthor('Colton Jones')
    c.setSubject('Synthetic reference form. No real company or customer records.')
    c.setCreator('HeatSynQ fictional sample generator')
    c.setFillColor(INK)
    c.rect(0, HEIGHT - 116, WIDTH, 116, fill=1, stroke=0)
    text(c, 42, HEIGHT - 40, 'HeatSynQ / FICTIONAL EXAMPLE', 11, True, white)
    text(c, 42, HEIGHT - 78, title, 25, True, white)
    text(c, 42, HEIGHT - 101, number + '  |  Example date: 2026-09-01', 10, False, white)
    y = HEIGHT - 148
    text(c, 42, y, 'Example Heat Treat - fictional business', 13, True)
    text(c, 42, y - 21, '100 Example Way, Example City, ZZ 00000', 10)
    text(c, 42, y - 40, 'office@example.com  |  202-555-0100', 10, color=MUTED)
    y -= 72
    for heading, rows in sections:
        y = block(c, y, heading, rows)
    if y < 95:
        raise ValueError(f'Content exceeds one-page layout: {filename}')
    c.setStrokeColor(HexColor('#b4c3cf'))
    c.line(42, 77, 570, 77)
    text(c, 42, 60, 'FICTIONAL DATA - for software examples only; not a business record.', 9, True)
    text(c, 42, 44, 'No real signature, inspection, shipment or financial transaction is represented.', 8)
    text(c, 42, 29, 'Copyright 2026 Colton Jones | Apache-2.0 | Page 1 of 1', 8, color=MUTED)
    c.showPage()
    c.save()

customer = [('Customer', 'Fictional Components'), ('Address', '200 Sample Road, Example City, ZZ 00000')]
part = [('Part number', 'DEMO-RG-1001'), ('Description', 'Example ring gear'), ('Quantity / weight', '120 pieces / 150.00 lb')]
make('Order Form Sample.pdf', 'Order form', 'DEMO-ORDER-1001', [
    ('Customer', customer + [('Purchase order', 'DEMO-PO-1001')]),
    ('Order details', part + [('Process', 'Example process - no operating recipe')]),
    ('Instructions', [('Requested due date', '2026-09-08'), ('Handling', 'Fictional packaging instructions')]),
])
make('Bill of Lading Sample.pdf', 'Bill of lading', 'DEMO-BOL-1001', [
    ('Consignee', customer),
    ('Shipment', [('Shipper reference', 'DEMO-SHIP-1001'), ('Carrier', 'Example Carrier'),
                  ('Packages / weight', '2 example crates / 150.00 lb'), ('Contents', '120 example ring gears')]),
    ('Receipt', [('Freight terms', 'Illustration only'), ('Carrier signature', 'Not signed - fictional example')]),
])
make('Certification Sample.pdf', 'Certification example', 'DEMO-CERT-1001', [
    ('Customer', customer + [('Order / purchase order', 'DEMO-ORDER-1001 / DEMO-PO-1001')]),
    ('Example inspection', [('Part number', 'DEMO-RG-1001'), ('Quantity', '120 pieces'),
                            ('Result', 'Illustrative field - no test performed')]),
    ('Authorization', [('Conformance', 'No conformance claim is made'), ('Signature', 'Not signed - fictional example')]),
])
make('Invoice Sample.pdf', 'Invoice example', 'DEMO-INV-1001', [
    ('Bill to', customer + [('Purchase order', 'DEMO-PO-1001')]),
    ('Charges', [('Example processing', '120 pieces x $4.25 = $510.00'),
                 ('Example handling', '$25.00'), ('Tax', '$0.00'), ('Total', '$535.00')]),
    ('Terms', [('Payment terms', 'Example net 30'), ('Payment status', 'No payment is requested')]),
])
make('Quote Sample.pdf', 'Quote example', 'DEMO-QUOTE-1001', [
    ('Prepared for', customer + [('Contact', 'buyer@example.com')]),
    ('Proposed example work', [('Part number', 'DEMO-RG-1001'), ('Quantity / unit price', '120 pieces / $4.25'),
                               ('Handling / total', '$25.00 / $535.00')]),
    ('Conditions', [('Valid through', '2026-09-30'), ('Status', 'Fictional example; not an offer')]),
])
make('Shipping Ticket Sample.pdf', 'Shipping ticket', 'DEMO-SHIP-1001', [
    ('Ship to', customer + [('Order / purchase order', 'DEMO-ORDER-1001 / DEMO-PO-1001')]),
    ('Packed items', part + [('Containers', '2 example crates')]),
    ('Dispatch', [('Carrier', 'Example Carrier'), ('Received by', 'Not signed - fictional example')]),
])
print('Generated six fictional one-page PDF examples.')
