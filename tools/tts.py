#!/usr/bin/env python3
"""Gemini TTS with durable project quotas. No keys are written to the ledger."""
import argparse, base64, hashlib, io, json, os, sqlite3, time, urllib.request, urllib.error, wave
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
MODEL='gemini-3.8-flash-lite-tts'
ENDPOINT='https://generativelanguage.googleapis.com/v1beta/interactions'

def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def atomic(file,value):
    file=Path(file);file.parent.mkdir(parents=True,exist_ok=True);tmp=file.with_name(file.name+'.part');tmp.write_text(json.dumps(value,indent=2)+'\n');os.replace(tmp,file)

class Quotas:
    def __init__(self,file):
        Path(file).parent.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(file,timeout=30,isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,scope TEXT,created REAL,day TEXT,tokens INTEGER,status TEXT,lease_until REAL); CREATE TABLE IF NOT EXISTS cooldown(scope TEXT PRIMARY KEY,until REAL);')
    def close(self):
        if self.db is not None:
            self.db.close()
            self.db=None
    def __del__(self):
        try:self.close()
        except Exception:pass
    def reserve(self,scope,tokens,limits,now=None):
        now=now if now is not None else time.time();day=datetime.fromtimestamp(now,ZoneInfo('America/Los_Angeles')).date().isoformat()
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row=self.db.execute('SELECT until FROM cooldown WHERE scope=?',(scope,)).fetchone()
            if row and row[0]>now: return None,'cooldown'
            rpm,tpm=self.db.execute('SELECT count(*),coalesce(sum(tokens),0) FROM requests WHERE scope=? AND created>?',(scope,now-60)).fetchone()
            rpd=self.db.execute('SELECT count(*) FROM requests WHERE scope=? AND day=?',(scope,day)).fetchone()[0]
            active=self.db.execute("SELECT count(*) FROM requests WHERE scope=? AND status='started' AND lease_until>?",(scope,now)).fetchone()[0]
            if rpm>=limits['rpm'] or tpm+tokens>limits['tpm'] or rpd>=limits['rpd'] or active>=limits.get('concurrency',1):return None,'quota exhausted'
            cur=self.db.execute('INSERT INTO requests(scope,created,day,tokens,status,lease_until) VALUES(?,?,?,?,?,?)',(scope,now,day,tokens,'started',now+930));return cur.lastrowid,None
        finally:self.db.execute('COMMIT')
    def finish(self,id,status):self.db.execute('UPDATE requests SET status=?,lease_until=0 WHERE id=?',(status,id))
    def cool(self,scope,seconds):self.db.execute('INSERT INTO cooldown VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET until=max(until,excluded.until)',(scope,time.time()+seconds))

def body(text,model,voice,style):
    part={'type':'text','text':text}
    if style:part['annotations']=[{'type':'speech_metadata','style':style}]
    return {'model':model,'input':[{'type':'user_input','content':[part]}],'response_format':{'type':'audio','mime_type':'audio/wav','sample_rate':24000},'generation_config':{'speech_config':[{'voice':voice}]}}

def decode(response):
    if response.get('status') not in (None,'completed'):raise ValueError('TTS interaction not completed')
    parts=[p for step in response.get('steps',[]) if step.get('type')=='model_output' for p in step.get('content',[]) if p.get('type')=='audio']
    if not parts and response.get('output_audio'):parts=[response['output_audio']]
    if not parts:raise ValueError('No audio in TTS response')
    frames=[];params=None
    for p in parts:
        with wave.open(io.BytesIO(base64.b64decode(p['data'],validate=True))) as wav:
            current=(wav.getnchannels(),wav.getsampwidth(),wav.getframerate())
            if params and current!=params:raise ValueError('Incompatible TTS audio chunks')
            params=current;data=wav.readframes(wav.getnframes())
            if not data:raise ValueError('Empty audio')
            frames.append(data)
    out=io.BytesIO()
    with wave.open(out,'wb') as wav:wav.setnchannels(params[0]);wav.setsampwidth(params[1]);wav.setframerate(params[2]);wav.writeframes(b''.join(frames))
    return out.getvalue(),response.get('usage',{})

def generate(config,script,out,max_requests=0,ledger=None,request=None):
    out=Path(out);out.mkdir(parents=True,exist_ok=True);quota=Quotas(ledger or Path.home()/'.cache/lucent/tts.sqlite3')
    limits={'rpm':3,'tpm':10000,'rpd':10,'concurrency':1,**config.get('limits',{})}
    if any(not isinstance(v,int) or v<1 for v in limits.values()):raise ValueError('Quota limits must be positive integers')
    model=config.get('model',MODEL);voice=config.get('voice','Sadaltager');style=config.get('style','Clear, natural, steady conversational delivery.')
    keys=config.get('keys',[{'env':'GKEY','project':'default'}]);used=0;result=[]
    for cue in script['cues']:
        text=cue.get('spoken',cue['text']);request_body=body(text,model,cue.get('voice',voice),cue.get('style',style));key=digest({'apiVersion':'0.1.0','cacheVersion':1,'body':request_body});file=out/(key+'.wav');meta=out/(key+'.json')
        cached=False
        if file.exists() and meta.exists():
            try:
                m=json.loads(meta.read_text())
                with wave.open(str(file)) as w:cached=w.getnframes()>0 and m['checksum']==hashlib.sha256(file.read_bytes()).hexdigest()
            except (ValueError,KeyError,wave.Error,EOFError):pass
        if cached:result.append({'cue':cue['id'],'scene':cue['scene'],'time':cue['time'],'file':str(file),'cached':True});continue
        if used>=max_requests:result.append({'cue':cue['id'],'state':'budget exhausted','key':key});continue
        # UTF-8 byte count is a deliberately conservative input-token upper bound.
        tokens=len(json.dumps(request_body,ensure_ascii=False).encode())
        if tokens>limits['tpm']:result.append({'cue':cue['id'],'state':'request exceeds token budget; split cue'});continue
        selected=None
        for credential in keys:
            secret=os.environ.get(credential['env'])
            if not secret:continue
            scope=credential['project']+':'+model
            reservation,reason=quota.reserve(scope,tokens,limits)
            if reservation:selected=(secret,scope,reservation);break
        if not selected:result.append({'cue':cue['id'],'state':'no eligible quota group; checkpointed'});continue
        secret,scope,reservation=selected;used+=1
        try:
            if request:response=request(request_body,secret)
            else:
                req=urllib.request.Request(ENDPOINT,data=json.dumps(request_body).encode(),headers={'Content-Type':'application/json','x-goog-api-key':secret})
                with urllib.request.urlopen(req,timeout=900) as r:response=json.load(r)
            audio,usage=decode(response);temp=file.with_name(file.name+'.part');temp.write_bytes(audio);os.replace(temp,file);atomic(meta,{'schemaVersion':1,'hash':key,'checksum':hashlib.sha256(audio).hexdigest(),'body':request_body,'usage':usage,'scope':scope});quota.finish(reservation,'completed');result.append({'cue':cue['id'],'scene':cue['scene'],'time':cue['time'],'file':str(file),'cached':False})
        except urllib.error.HTTPError as e:
            quota.finish(reservation,'failed');retry=e.headers.get('Retry-After','60')
            try:seconds=max(60,float(retry))
            except ValueError:seconds=60
            quota.cool(scope,seconds if e.code==429 else 900)
            result.append({'cue':cue['id'],'state':'retry pending','httpStatus':e.code})
            e.close()
        except Exception as e:
            quota.finish(reservation,'failed');quota.cool(scope,60);result.append({'cue':cue['id'],'state':'retry pending','errorType':type(e).__name__})
    if used>0 and used<max_requests and any(c.get('state')=='retry pending' for c in result):
        resumed=generate(config,script,out,max_requests-used,ledger,request)
        resumed['requests']+=used
        atomic(out/'narration.json',resumed)
        return resumed
    manifest={'schemaVersion':1,'scriptHash':digest(script),'requests':used,'cues':result};atomic(out/'narration.json',manifest);return manifest

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--script',required=True);parser.add_argument('--out',required=True);parser.add_argument('--max-requests',type=int,default=0);args=parser.parse_args()
    if args.max_requests<0:parser.error('max-requests must be nonnegative')
    print(json.dumps(generate(json.loads(Path(args.config).read_text()),json.loads(Path(args.script).read_text()),args.out,args.max_requests),indent=2))
