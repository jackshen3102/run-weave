"""Read only the probe's exported local copy; never access Apple's live stores."""
from pathlib import Path
import sys,json,struct,collections,datetime,hashlib,math,argparse,csv
from zoneinfo import ZoneInfo
sys.path.insert(0,str(Path(__file__).parent/'vendor'))
from ccl_segb import read_segb_file
from usage_intervals import pair_events
args=argparse.ArgumentParser(description='Parse an explicit ScreenJournal App.InFocus export; never read live system stores.')
args.add_argument('snapshot',type=Path,help='Export directory containing manifest.json')
args.add_argument('--timezone',default='Asia/Shanghai')
options=args.parse_args()
root=options.snapshot.resolve(strict=True)
manifest=json.loads((root/'manifest.json').read_text())
zone=ZoneInfo(options.timezone)
peers=manifest.get('deviceIdentity',{}).get('devices',[])
def identity(device):
 return next((p for p in peers if p.get('device_identifier','').upper()==device.upper()),None)
epoch=datetime.datetime(2001,1,1,tzinfo=datetime.timezone.utc)
def varint(b,i):
 v=0
 for shift in range(0,70,7):
  n=b[i];i+=1;v|=(n&127)<<shift
  if n<128:return v,i
 raise ValueError('Invalid varint')
def decode(b):
 fields={};i=0
 while i<len(b):
  key,i=varint(b,i);number,wire=key>>3,key&7
  if wire==0:fields[number],i=varint(b,i)
  elif wire==1:fields[number]=struct.unpack_from('<d',b,i)[0];i+=8
  elif wire==2:
   n,i=varint(b,i);fields[number]=b[i:i+n];i+=n
  elif wire==5:i+=4
  else:raise ValueError('Unknown wire')
 if i!=len(b):raise ValueError('Invalid length')
 t=fields.get(4);app=fields.get(6,b'').decode()
 if not app or not isinstance(t,float) or not math.isfinite(t) or not 0<=t<=253000000000 or fields.get(3) not in (0,1):return None
 return t,app,fields.get(3)==1

def date(t):return (epoch+datetime.timedelta(seconds=t)).astimezone(zone)
summary=[];all_sessions=[];all_events=[];daily=collections.defaultdict(float)
for device in sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink()):
 counts=collections.Counter();events=set();fileinfo=[]
 for file in sorted(device.iterdir()):
  if not file.name.isdigit() or not file.is_file() or file.is_symlink():continue
  fileinfo.append({'file':file.name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
  try:
   for rec in read_segb_file(file):
    counts['records']+=1
    if rec.state!=1:counts['not_written']+=1;continue
    if not rec.crc_passed:counts['crc_failed']+=1;continue
    try:event=decode(rec.data)
    except (IndexError,ValueError,struct.error,UnicodeError):counts['decode_failed']+=1;continue
    if event is None:counts['missing_fields']+=1;continue
    events.add(event)
  except Exception as e:fileinfo[-1]['error']=repr(e)
 # A focus transition emits the old loss and new gain at the same timestamp.
 # Close the old interval before opening the new one, independent of bundle ID.
 ordered=sorted(events,key=lambda e:(e[0],e[2],e[1]))
 for t,app,gained in ordered:
  all_events.append({'device_id':device.name,'timestamp':date(t).isoformat(),'app_id':app,'gained_focus':gained})
 sessions=pair_events(ordered,counts)
 for app,start,end,quality in sessions:
  if end<=start:counts['nonpositive_interval']+=1;continue
  duration=end-start
  if duration>14400:quality+=':over_4h'
  row={'device_id':device.name,'app_id':app,'start':date(start).isoformat(),'end':date(end).isoformat(),'seconds':duration,'quality':quality}
  all_sessions.append(row)
  a,b=date(start),date(end)
  while a<b:
   midnight=datetime.datetime.combine(a.date()+datetime.timedelta(days=1),datetime.time.min,tzinfo=zone)
   stop=min(midnight,b)
   daily[(device.name,str(a.date()),app,quality)]+=(stop-a).total_seconds();a=stop
 days=sorted({k[1] for k in daily if k[0]==device.name})
 recent=[]
 for day in days[-3:]:
  apps=collections.defaultdict(float);q=collections.Counter()
  for (dev,d,app,quality),sec in daily.items():
   if dev==device.name and d==day:apps[app]+=sec;q[quality]+=sec
  recent.append({'date':day,'apps':len(apps),'minutes':round(sum(apps.values())/60,2),'quality_minutes':{k:round(v/60,2) for k,v in q.items()},'top':sorted(((k,round(v/60,2)) for k,v in apps.items()),key=lambda x:-x[1])[:8]})
 summary.append({'device_id':device.name,'identity':identity(device.name),'events':len(ordered),'first':date(ordered[0][0]).isoformat() if ordered else None,'last':date(ordered[-1][0]).isoformat() if ordered else None,'apps':len({x[1] for x in ordered}),'counts':dict(counts),'files':fileinfo,'recent':recent})
(root/'parsed-events.json').write_text(json.dumps(all_events,ensure_ascii=False,indent=2))
(root/'parsed-sessions.json').write_text(json.dumps(all_sessions,ensure_ascii=False,indent=2))
(root/'daily-usage.json').write_text(json.dumps([{'device_id':k[0],'date':k[1],'app_id':k[2],'quality':k[3],'seconds':v} for k,v in sorted(daily.items())],ensure_ascii=False,indent=2))
(root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
columns=['device_id','device_name','platform','hardware_model','device_kind','date','app_id','quality','seconds','timezone']
with (root/'daily-app-usage.csv').open('w',encoding='utf-8-sig',newline='') as f:
 writer=csv.DictWriter(f,fieldnames=columns);writer.writeheader()
 for (device,day,app,quality),seconds in sorted(daily.items()):
  peer=identity(device) or {}
  # Neutralize spreadsheet formulas in labels taken from external device metadata.
  safe=lambda s: "'"+s if s.startswith(('=','+','-','@','\t','\r')) else s
  writer.writerow(dict(zip(columns,[device,safe(peer.get('name','')),safe(peer.get('platform','')),safe(peer.get('hardware_model','')),safe(peer.get('device_kind','')),day,safe(app),quality,round(seconds,6),options.timezone])))
counts=collections.defaultdict(set)
for device,day,app,quality in daily:counts[(device,day)].add(app)
(root/'daily-app-counts.json').write_text(json.dumps([{'device_id':dev,'date':day,'bundle_id_count':len(apps),'non_apple_bundle_id_count':sum(not a.startswith('com.apple.') for a in apps)} for (dev,day),apps in sorted(counts.items())],ensure_ascii=False,indent=2))
for name in ['parsed-events.json','parsed-sessions.json','daily-usage.json','summary.json','daily-app-usage.csv','daily-app-counts.json']:(root/name).chmod(0o600)
print(json.dumps(summary,ensure_ascii=False,indent=2))
