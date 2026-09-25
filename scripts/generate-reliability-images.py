#!/usr/bin/env python3
"""Reproduce synthetic OCR fixtures. Pillow 11.3.0, macOS Arial fonts.

Run explicitly when authoring a new fixture revision, never during validation.
No existing validation image or baseline is modified.
"""
import hashlib
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'experiments/fixtures/agent-reliability-ocr'
OUT.mkdir(parents=True, exist_ok=True)
FONT = Path('/System/Library/Fonts/Supplemental/Arial.ttf')
BOLD = FONT.with_name('Arial Bold.ttf')
W, H = 1280, 900
INK = '#172438'
MUTED = '#536174'
BLUE = '#2d5e9c'

def font(size, bold=False):
    return ImageFont.truetype(str(BOLD if bold else FONT), size)

def page(title):
    image = Image.new('RGB', (W, H), '#fafbfd')
    d = ImageDraw.Draw(image)
    d.rectangle((0, 0, W, 16), fill=BLUE)
    d.text((72, 64), title, font=font(42, True), fill=INK)
    d.line((72, 135, 1208, 135), fill='#bec9d9', width=2)
    d.text((72, 842), 'Prepared synthetic worksheet • no private data', font=font(21), fill=MUTED)
    return image, d

def line(d, y, label, value):
    d.text((84, y), label, font=font(29, True), fill=INK)
    d.text((420, y), value, font=font(32), fill=INK)

def observation(field, value, status='readable', match=None):
    result = {'field':field, 'value':value, 'status':status}
    if match: result['match'] = match
    return result

PREFIX = 'Extract only the requested fields from this image. Return JSON with exactly this top-level shape: {"observations":[{"field":"requested field name","value":null,"status":"readable|unreadable|absent"}],"interpretations":[]}. Use one observation per requested field. Use JSON strings, numbers, arrays or objects as specified for readable values, null for unreadable or absent values. Do not provide a prose answer or call tools. Requested fields: '
fixtures=[]
def save(number, image, scenario, instructions, expected):
    name=f'{number:02d}.png'
    path=OUT/name
    image.save(path, optimize=True)
    data=path.read_bytes()
    assert len(data)<=500_000
    fixtures.append({'id':f'ocr-{number:02d}','scenario':scenario,'image':name,'width':W,'height':H,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'extractionPrompt':PREFIX+instructions,'expected':{'observations':expected,'interpretations':[]}})

im,d=page('Bench worksheet')
line(d,205,'Sample ID','R8-204')
line(d,298,'Water amount','35 mL')
line(d,391,'Observation time','18:45')
line(d,484,'Trial status','Proposed; not yet measured')
d.rounded_rectangle((72, 626, 1208, 753), 12, outline='#a9b9cc', width=2)
d.text((97, 658),'Keep both containers at the same temperature.',font=font(30),fill=INK)
save(1,im,'Clear identifiers, quantities and units','sampleId (string), waterAmountMl (number), observationTime (string), trialStatus (string).',[observation('sampleId','R8-204'),observation('waterAmountMl',35),observation('observationTime','18:45'),observation('trialStatus','Proposed; not yet measured')])

im,d=page('Sensor observations')
headers=['Run','Time (s)','Distance (cm)','Illumination (lx)']
rows=[['A','0','40','128'],['B','15','40','131'],['C','30','40','129'],['D','45','40','130']]
xs=[72,258,490,816,1208]; top=198; rh=95
for r,row in enumerate([headers]+rows):
 y=top+r*rh
 d.rectangle((xs[0],y,xs[-1],y+rh),fill='#e5edf7' if r==0 else ('#ffffff' if r%2 else '#f0f4f9'),outline='#a9b9cc',width=2)
 for c,text in enumerate(row):
  if c: d.line((xs[c],y,xs[c],y+rh),fill='#a9b9cc',width=2)
  d.text((xs[c]+17,y+30),text,font=font(26 if r==0 else 31,r==0),fill=INK)
d.text((74,736),'Instrument: LX-27     Temperature: 22 °C',font=font(29),fill=INK)
save(2,im,'Dense table with units','rows (array of objects in table order, each {run:string,timeSeconds:number,distanceCm:number,illuminationLux:number}), instrument (string), temperatureC (number).',[observation('rows',[{'run':row[0],'timeSeconds':int(row[1]),'distanceCm':int(row[2]),'illuminationLux':int(row[3])} for row in rows]),observation('instrument','LX-27'),observation('temperatureC',22)])

im,d=page('Instrument inspection')
line(d,220,'Instrument ID','Q2-718')
d.text((84,337),'Calibration value',font=font(29,True),fill=INK)
# An opaque field, with no recoverable underlying value.
d.rectangle((420,327,1040,397),fill='#101010')
line(d,460,'Inspection date','2026-09-18')
d.line((72,685,1208,685),fill='#a9b9cc',width=2)
d.text((84,719),'Footer code: K7-41',font=font(29),fill=INK)
save(3,im,'Fully hidden calibration value beside unrelated footer code','instrumentId (string), calibrationValue (string or null), inspectionDate (string), footerCode (string).',[observation('instrumentId','Q2-718'),observation('calibrationValue',None,'unreadable'),observation('inspectionDate','2026-09-18'),observation('footerCode','K7-41')])

im,d=page('Container record')
line(d,228,'Container ID','CN-5827')
# Hide a central span; visible prefix/suffix cannot establish the full ID.
d.rectangle((487,220,522,276),fill='#101010')
line(d,365,'Volume','250 mL')
line(d,500,'Storage','Room temperature')
d.text((84,689),'Transcribe the complete identifier only if readable.',font=font(27),fill=MUTED)
save(4,im,'Partially obscured identifier with readable nearby fields','containerId (complete string or null), volumeMl (number), storage (string).',[observation('containerId',None,'unreadable'),observation('volumeMl',250),observation('storage','Room temperature')])

im,d=page('Delivery receipt')
line(d,210,'Receipt number','D-406')
line(d,332,'Received on','2026-09-17')
line(d,454,'Quantity','12 boxes')
line(d,576,'Checked by','A. Chen')
save(5,im,'Requested batch lot field is absent','receiptNumber (string), batchLotNumber (string or null), quantityBoxes (number), receivedDate (string).',[observation('receiptNumber','D-406'),observation('batchLotNumber',None,'absent'),observation('quantityBoxes',12),observation('receivedDate','2026-09-17')])

im,d=page('Process sketch')
boxes={'Input':(80,340,310,455),'Filter':(490,340,730,455),'Output':(920,205,1180,320),'Waste':(920,505,1180,620)}
for label,box in boxes.items():
 d.rounded_rectangle(box,15,fill='#e5edf7',outline=BLUE,width=3)
 bounds=d.textbbox((0,0),label,font=font(34,True)); tw=bounds[2]-bounds[0]
 d.text(((box[0]+box[2]-tw)/2,box[1]+36),label,font=font(34,True),fill=INK)
def arrow(start,end):
 d.line((*start,*end),fill=INK,width=5)
 angle=math.atan2(end[1]-start[1],end[0]-start[0]); length=20
 p1=(end[0]-length*math.cos(angle-.45),end[1]-length*math.sin(angle-.45)); p2=(end[0]-length*math.cos(angle+.45),end[1]-length*math.sin(angle+.45))
 d.polygon([end,p1,p2],fill=INK)
arrow((310,397),(490,397));arrow((730,367),(920,265));arrow((730,425),(920,563))
d.text((84,724),'Arrows indicate direction of flow.',font=font(28),fill=MUTED)
save(6,im,'Directional graph with a split','nodeLabels (array of strings), directedEdges (array of [source,target] string pairs).',[observation('nodeLabels',list(boxes),'readable','unordered'),observation('directedEdges',[['Input','Filter'],['Filter','Output'],['Filter','Waste']],'readable','unordered')])
manifest={'version':1,'syntheticOnly':True,'generator':'scripts/generate-reliability-images.py','dimensions':[W,H],'maximumBytes':500000,'repeats':['ocr-03','ocr-04'],'fixtures':fixtures}
p=OUT/'manifest.json';p.write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'manifestSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'images':[{'id':f['id'],'bytes':f['bytes']} for f in fixtures]},indent=2))
