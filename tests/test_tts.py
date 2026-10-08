import unittest,tempfile,sys,time,concurrent.futures,io,wave,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from tts import Quotas,body,decode,generate
class TestQuotas(unittest.TestCase):
 def test_shared_project_and_token_limits(self):
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'q.sqlite';q=Quotas(file);limits={'rpm':3,'tpm':10,'rpd':10,'concurrency':1};id,_=q.reserve('project:model',6,limits);self.assertIsNotNone(id);self.assertIsNone(Quotas(file).reserve('project:model',2,limits)[0]);q.finish(id,'completed');self.assertIsNone(q.reserve('project:model',6,limits)[0]);self.assertIsNotNone(q.reserve('other:model',6,limits)[0])
 def test_pacific_day_and_cooldown(self):
  with tempfile.TemporaryDirectory() as d:
   q=Quotas(Path(d)/'q.sqlite');lim={'rpm':100,'tpm':10000,'rpd':1};a,_=q.reserve('p',1,lim,1760000000);q.finish(a,'completed');self.assertIsNone(q.reserve('p',1,lim,1760000061)[0]);self.assertIsNotNone(q.reserve('p',1,lim,1760100000)[0]);q.cool('x',60);self.assertIsNone(q.reserve('x',1,lim)[0])
 def test_multi_wav_decode(self):
  b=io.BytesIO()
  with wave.open(b,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(b'\x01\x00'*100)
  part={'type':'audio','data':base64.b64encode(b.getvalue()).decode()};data,_=decode({'steps':[{'type':'model_output','content':[part,part]}]})
  with wave.open(io.BytesIO(data)) as w:self.assertEqual(w.getnframes(),200)
 def test_style_is_not_spoken(self):
  value=body('Hello','model','voice','Cheerful');self.assertEqual(value['input'][0]['content'][0]['text'],'Hello')
if __name__=='__main__':unittest.main()

class TestRotation(unittest.TestCase):
 def test_429_rotates_and_cache_skips_network(self):
  import os,urllib.error
  with tempfile.TemporaryDirectory() as d:
   os.environ['FILM_KEY_A']='test-a';os.environ['FILM_KEY_B']='test-b';calls=[]
   b=io.BytesIO()
   with wave.open(b,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(b'\x00\x00'*10)
   response={'steps':[{'type':'model_output','content':[{'type':'audio','data':base64.b64encode(b.getvalue()).decode()}]}]}
   def request(body,key):
    calls.append(key)
    if key=='test-a':raise urllib.error.HTTPError('https://example.invalid',429,'rate limit',{},None)
    return response
   config={'keys':[{'env':'FILM_KEY_A','project':'a'},{'env':'FILM_KEY_B','project':'b'}]};script={'cues':[{'id':'a','scene':'s','time':0,'text':'Hi'}]}
   result=generate(config,script,Path(d)/'out',2,Path(d)/'quota.db',request)
   self.assertEqual(calls,['test-a','test-b']);self.assertIn('file',result['cues'][0]);self.assertEqual(result['requests'],2)
   generate(config,script,Path(d)/'out',2,Path(d)/'quota.db',request);self.assertEqual(len(calls),2)
   del os.environ['FILM_KEY_A'];del os.environ['FILM_KEY_B']

class TestConcurrency(unittest.TestCase):
 def test_transaction_reservations_across_clients(self):
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'q.sqlite';Quotas(file);limits={'rpm':3,'tpm':100,'rpd':10,'concurrency':1}
   def reserve(_):return Quotas(file).reserve('same-project:model',1,limits)[0]
   with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(reserve,range(8)))
   self.assertEqual(sum(x is not None for x in results),1)
