"""Review-only CC0 tactile samples + original game cue arrangements. Run at repo root."""
from pathlib import Path
import hashlib,json,subprocess,zipfile,urllib.request
import numpy as np
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'static/v7-preview/game-audio';OUT.mkdir(parents=True,exist_ok=True)
REF=ROOT/'artifacts/audio-references-20260930';REF.mkdir(parents=True,exist_ok=True);SR=48000;sources={}
PACK_URL='https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip'
if not (REF/'casino.zip').exists():urllib.request.urlretrieve(PACK_URL,REF/'casino.zip')
assert hashlib.sha256((REF/'casino.zip').read_bytes()).hexdigest()=='f36250766ac5bc378c13708ddf12a23a8e54a3251f8d482c7536e51b5dbafa18', 'Reference pack changed; review its source and license before rebuilding'
def ff(args,data=None):return subprocess.run(['ffmpeg','-hide_banner','-loglevel','error',*args],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stdout
def source(name):
 with zipfile.ZipFile(REF/'casino.zip') as z:
  raw=z.read('Audio/'+name+'.ogg');(OUT/'casino-LICENSE.txt').write_bytes(z.read('License.txt'))
 sources[name]={'file':name+'.ogg','sha256':hashlib.sha256(raw).hexdigest(),'processing':'mono decode, trim, resample, lowpass, envelope, mix'}
 return np.frombuffer(ff(['-i','pipe:0','-f','f32le','-ac','1','-ar',str(SR),'pipe:1'],raw),np.float32).copy()
collisions=[source('chips-collide-'+str(i)) for i in range(1,4)]
roll=source('dice-shake-1');click=source('chip-lay-1');slide=source('card-slide-1');opening=source('cards-pack-open-1')
def lowpass(x,hz):
 f=np.fft.rfftfreq(len(x),1/SR);return np.fft.irfft(np.fft.rfft(x)/(1+(f/hz)**6),n=len(x))
def env(x,attack=.005,decay=5):
 t=np.arange(len(x))/SR;return x*np.minimum(t/max(attack,.001),1)*np.exp(-t/max(len(x)/SR,.001)*decay)
def sample(x,dur=.15,rate=1,cut=3500):
 y=np.interp(np.arange(int(dur*SR))*rate,np.arange(len(x)),x,left=0,right=0);y=lowpass(y,cut);y/=max(np.max(np.abs(y)),.001)
 n=min(int(.006*SR),len(y)//2);y[:n]*=np.linspace(0,1,n);y[-n:]*=np.linspace(1,0,n);return y
families={
'a':dict(name='欢乐街机',root=523.25,color='mallet',steps=[0,4,7,12],tempo=.115,body=.55,cut=4200),
'b':dict(name='机械游乐场',root=392.,color='brass',steps=[0,7,4,12],tempo=.14,body=.75,cut=3000),
'c':dict(name='能量引擎',root=440.,color='digital',steps=[0,7,12,16],tempo=.09,body=.65,cut=4700),
'd':dict(name='魔法水晶',root=587.33,color='crystal',steps=[0,2,7,12,14],tempo=.115,body=.45,cut=4800)}
def voice(f,dur=.3,color='mallet',sweep=1):
 t=np.arange(int(dur*SR))/SR;phase=2*np.pi*np.cumsum(f*(1+(sweep-1)*np.exp(-t/.045)))/SR
 if color=='mallet':y=np.sin(phase)+.28*np.sin(phase*3)*np.exp(-t*22)+.12*np.sin(phase*5)*np.exp(-t*35);atk=.003;dec=5
 elif color=='brass':y=sum(np.sin(phase*k)/k**1.4 for k in range(1,8));atk=.015;dec=3.8
 elif color=='digital':y=np.sin(phase+1.4*np.sin(phase*2)*np.exp(-t*9))+.22*np.sin(phase/2);atk=.004;dec=4.5
 else:y=np.sin(phase+.55*np.sin(phase*3.51)*np.exp(-t*5))+.18*np.sin(phase*2.01)*np.exp(-t*10);atk=.004;dec=4
 return env(y,atk,dec)*.45

def mix(dur,layers):
 y=np.zeros(int(dur*SR))
 for start,x,gain in layers:
  offset=int(start*SR);n=min(len(x),len(y)-offset)
  if n>0:y[offset:offset+n]+=x[:n]*gain
 return y

def spatial(x,wet=.10):
 l=x.copy();r=x.copy()
 for secs,g in [(.071,wet),(.123,wet*.6)]:
  n=int(SR*secs)
  if n<len(x):r[n:]+=x[:-n]*g;l[n:]+=x[:-n]*g*.45
 return np.stack([l,r],axis=1)
def export(name,x,wet=.08):
 x=spatial(x,wet);x*=min(1,.78/max(np.max(np.abs(x)),.001))
 ff(['-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0','-c:a','libvorbis','-q:a','5','-y',str(OUT/(name+'.ogg'))],x.astype(np.float32).tobytes())
 return dict(url='./game-audio/'+name+'.ogg',duration=round(len(x)/SR,3),peakDbfs=round(20*np.log10(max(np.max(np.abs(x)),1e-9)),2))
manifest=dict(version='game-audio-review-1',sampleRate=SR,sources={},candidates={},themeAssignments=dict(default=None,cosmic=None))
for key,p in families.items():
 root=p['root'];col=p['color'];cues={};waveforms={}
 def add(name,dur,layers,wet=.08):
  x=lowpass(mix(dur,layers),p['cut']);waveforms[name]=x;cues[name]=export(key+'-'+name,x,wet)
 add('press',.17,[(0,sample(click,.075,cut=3000),.18),(0,voice(root*.5,.15,col,1.12),.28)])
 add('start',.62,[(0,voice(root*.25,.42,col,.55),.43),(.10,voice(root*.5,.36,col,.70),.25),(.20,voice(root,.30,col,.9),.20)])
 for i in range(3):add('capsule-hit-'+str(i),.22,[(0,sample(collisions[i],.16,rate=.86+i*.07,cut=2500),.24*p['body']),(0,voice(180+i*37,.105,col,1.1),.19)])
 add('capsule-roll',.82,[(0,sample(roll,.77,rate=1.15,cut=2200),.19*p['body'])])
 add('wheel-tick',.11,[(0,sample(click,.065,rate=1.15,cut=3400),.17),(.003,voice(root*1.2,.08,col,1.07),.20)])
 add('sphere-pass',.48,[(0,sample(slide,.33,rate=1.3,cut=2500),.09),(.015,voice(root*.75,.44,col,1.45),.22)],.10)
 add('rise',.90,[(i*.09,voice(root*2**(n/12),.38,col,.92),.14+i*.012) for i,n in enumerate([0,2,4,7,9,12])],.09)
 add('exit',.42,[(0,sample(collisions[0],.17,rate=.78,cut=2500),.21),(.13,sample(collisions[1],.15,rate=.82,cut=2200),.15),(.23,voice(root*.5,.17,col,1.25),.16)])
 add('land',.33,[(0,voice(105,.24,col,1.65),.55),(.005,sample(click,.10,rate=.72,cut=2600),.28),(.025,voice(root*.5,.27,col,1),.24)])
 add('open',.33,[(0,sample(opening,.18,rate=1.6,cut=3500),.14),(.015,voice(root*1.5,.18,col,1.65),.24),(.075,voice(root*2,.20,col,1),.20)])
 layers=[(i*p['tempo'],voice(root*2**(n/12),.66,col),.47) for i,n in enumerate(p['steps'])];arrival=(len(p['steps'])-1)*p['tempo']
 for n,g in [(0,.25),(4,.18),(7,.19),(12,.10)]:layers.append((arrival,voice(root*2**(n/12),1.25,col),g))
 layers.append((arrival,voice(98,.25,col,1.35),.34))
 if key=='d':
  for i,n in enumerate([19,16,12,7]):layers.append((.70+i*.10,voice(root*2**(n/12),.55,col,1.08),.09))
 add('reveal',2.10,layers,.14 if key in 'cd' else .05);add('return',.22,[(0,voice(root,.18,col,.7),.17)])
 manifest['candidates'][key]=dict(name=p['name'],cues=cues)
 seq=[(0,waveforms['press'],1),(.16,waveforms['start'],1)]
 for i,t in enumerate(np.arange(.72,6.3,.24)):seq.append((float(t),waveforms['capsule-hit-'+str(i%3)],.72))
 for t in [1.1,2.2,3.3,4.4,5.5]:seq.append((t,waveforms['capsule-roll'],.52))
 seq += [(6.35,waveforms['rise'],.70),(7.1,waveforms['exit'],1),(7.75,waveforms['land'],.8),(8.,waveforms['open'],.8),(8.16,waveforms['reveal'],1)]
 raw=spatial(mix(11,seq),.07).astype(np.float32)
 result=subprocess.run(['ffmpeg','-hide_banner','-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0','-af','loudnorm=I=-18:TP=-1.5:LRA=9:print_format=json','-f','null','-'],input=raw.tobytes(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
 txt=result.stderr.decode('utf-8','replace');stats=json.loads(txt[txt.rfind('{'):txt.rfind('}')+1])
 norm='loudnorm=I=-18:TP=-1.5:LRA=9:measured_I={input_i}:measured_TP={input_tp}:measured_LRA={input_lra}:measured_thresh={input_thresh}:offset={target_offset}:linear=true'.format(**stats)
 ff(['-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0','-af',norm,'-ar',str(SR),'-c:a','libvorbis','-q:a','5','-y',str(OUT/(key+'-reel.ogg'))],raw.tobytes())
 check=subprocess.run(['ffmpeg','-hide_banner','-i',str(OUT/(key+'-reel.ogg')),'-af','loudnorm=I=-18:TP=-1.5:LRA=9:print_format=json','-f','null','-'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stderr.decode('utf-8','replace')
 final=json.loads(check[check.rfind('{'):check.rfind('}')+1])
 gain=min(-18-float(final['input_i']),-1.7-float(final['input_tp']))
 reel=OUT/(key+'-reel.ogg');encoded=reel.read_bytes()
 ff(['-i','pipe:0','-af','volume='+str(gain)+'dB','-c:a','libvorbis','-q:a','5','-y',str(reel)],encoded)
 check=subprocess.run(['ffmpeg','-hide_banner','-i',str(reel),'-af','loudnorm=I=-18:TP=-1.5:LRA=9:print_format=json','-f','null','-'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stderr.decode('utf-8','replace')
 final=json.loads(check[check.rfind('{'):check.rfind('}')+1])
 manifest['candidates'][key]['runtimeGain']=round(min(3.5,10**((-18-float(stats['input_i']))/20)),3)
 manifest['candidates'][key]['reel']=dict(url='./game-audio/'+key+'-reel.ogg',duration=11,measuredLUFS=float(final['input_i']),truePeakDbTP=float(final['input_tp']))
 print(key,p['name'],manifest['candidates'][key]['reel'],flush=True)
manifest['sources']=dict(publisher='Kenney',license='CC0-1.0',page='https://kenney.nl/assets/casino-audio',inputs=sources,originalSynthesis='scripts/build_game_audio.py: original instrumental voices, pitch envelopes, reward melodies and arrangements')
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Written',len(list(OUT.glob('*.ogg'))),'audio assets',sum(p.stat().st_size for p in OUT.glob('*')),'bytes')
