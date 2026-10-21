"""Six complete auditions grouped by the two product themes, not extra themes."""
from pathlib import Path
import hashlib
import json
import math
import urllib.request
import zipfile
import numpy as np
import build_soft_audio_review as core

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'static/v7-preview/theme-audio'
CACHE=ROOT/'artifacts/theme-audio-sources-20260930'
for folder in [OUT,CACHE]:folder.mkdir(parents=True,exist_ok=True)
core.OUT=OUT
SR=core.SR
PACK_URL='https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip'
PACK_SHA='b729ba57959bd58793d2c5cafa348aaf2655d354f3da35ec4729e03ec77197b8'
PRESETS={
 'default1':dict(theme='default',name='默认方案一',character='轻快弹跳',
  description='弹性的短音推动抽取，揭晓用一小段上行乐句收住。',
  instrument='pizzi',root=261.63,motion=.36,wet=.07),
 'default2':dict(theme='default',name='默认方案二',character='清透铃音',
  description='清透而疏落的游戏反馈，减速变得清晰，揭晓轻盈明亮。',
  instrument='steel',root=392.,motion=.49,wet=.11),
 'default3':dict(theme='default',name='默认方案三',character='圆润短音',
  description='圆润、温暖的短音，过程有轻节奏，结果落得干净。',
  instrument='sax',root=196.,motion=.43,wet=.08),
 'cosmic1':dict(theme='cosmic',name='星空方案一',character='空灵舒展',
  description='沿用星海空灵的柔和音色，运转舒展，揭晓是一束柔光。',
  root=196.,notes=[392.,493.88,587.33,493.88],motion=1.10,wet=.13),
 'cosmic2':dict(theme='cosmic',name='星空方案二',character='星光流动',
  description='疏落的星光音符从左右掠过，汇聚后亮起一串清光。',
  root=261.63,notes=[523.25,659.25,783.99,659.25],motion=.90,wet=.21),
 'cosmic3':dict(theme='cosmic',name='星空方案三',character='温暖星海',
  description='低而温暖的星海底色，音符缓缓升起，揭晓宽阔柔和。',
  root=146.83,notes=[293.66,369.99,440.,369.99],motion=1.38,wet=.26),
}
SOURCE_PATHS={
 'pizzi':('Audio/Pizzicato jingles/jingles_PIZZI06.ogg',60,.145),
 'steel':('Audio/Steel jingles/jingles_STEEL06.ogg',59,.155),
 'sax':('Audio/Sax jingles/jingles_SAX06.ogg',72,.14),
}


def instruments():
    path=CACHE/'music-jingles.zip'
    if not path.exists():urllib.request.urlretrieve(PACK_URL,path)
    if hashlib.sha256(path.read_bytes()).hexdigest()!=PACK_SHA:
        raise ValueError('Reference pack changed; review source and license before rebuilding')
    samples={};sources={}
    with zipfile.ZipFile(path) as archive:
        (OUT/'kenney-LICENSE.txt').write_bytes(archive.read('License.txt'))
        for key,(name,midi,cut) in SOURCE_PATHS.items():
            raw=archive.read(name)
            waveform=np.frombuffer(core.command(['-i','pipe:0','-f','f32le','-ar',str(SR),'-ac','2','pipe:1'],raw),np.float32).reshape(-1,2).astype(float)
            # Take one note, then use it as a tuned instrument throughout the cue.
            waveform=waveform[:int(cut*SR)]
            waveform-=waveform.mean(axis=0)
            waveform/=max(np.max(np.abs(waveform)),.001)
            samples[key]=(core.fades(waveform,.004,.022),440*2**((midi-69)/12))
            sources[key]=dict(file=name,sha256=hashlib.sha256(raw).hexdigest(),
                publisher='Kenney',license='CC0-1.0',page='https://kenney.nl/assets/music-jingles',
                processing='Single note extraction, tuning, transient softening, envelopes and arrangement')
    return samples,sources


def sampled_note(sample,frequency,duration=.28,softness=.01):
    raw,base=sample
    rate=frequency/base
    position=np.arange(int(duration*SR))*rate
    sound=np.stack([np.interp(position,np.arange(len(raw)),raw[:,c],left=0,right=0) for c in range(2)],axis=1)
    # A quiet resonant body prevents tiny sampled notes sounding like hard clicks.
    time=np.arange(len(sound))/SR
    body=np.sin(2*math.pi*frequency*time)*np.exp(-time*7/max(duration,.05))*.075
    sound+=np.stack([body,body],axis=1)
    return core.fades(core.lowpass(sound,3000),softness,.08)


def stellar_note(frequency,duration=.85,attack=.07,partial=0.):
    time=np.arange(int(duration*SR))/SR
    # Shape the original stellar sine envelope, rather than adding unrelated SFX.
    envelope=np.where(time<attack,np.clip(time/attack,0,1),
        np.exp(-(time-attack)*6.4/max(duration-attack,.01)))
    signal=(np.sin(2*math.pi*frequency*time)+partial*np.sin(2*math.pi*frequency*2*time))*envelope
    return core.fades(np.stack([signal,signal],axis=1),.008,.10)


def arrange(key,samples):
    preset=PRESETS[key];result=np.zeros((16*SR,2));events=[]
    def add(start,sound,gain,event,position=0.):
        offset=int(start*SR);length=min(len(sound),len(result)-offset)
        if length>0:result[offset:offset+length]+=core.pan(sound[:length],position)*gain
        events.append(dict(time=round(start,3),kind=event,gain=round(gain,4)))
    if preset['theme']=='default':
        sample=samples[preset['instrument']];root=preset['root']
        def note(ratio,duration=.30):return sampled_note(sample,root*ratio,duration,.01 if key=='default1' else .018)
        for at,ratio,gain in [(0.,1,.13),(.17,1.5,.11),(.34,2,.095)]:
            add(at,note(ratio),gain,'start')
        # The process is an action phrase, with rests and variation, not a song bed.
        ratios=[1,1.25,1.5,1.25,1,1.5,2,1.5]
        at=.92;index=0
        while at<8.7:
            pattern=(index//8)%2
            ratio=ratios[index%len(ratios)]*(1.0 if not pattern else .75)
            gain=.085 if index%4==0 else .046
            add(at,note(ratio,.27),gain,'motion',.22*math.sin(at*.7))
            interval=preset['motion']*(1.0-.18*min(at/6,1))
            if index%8==7:interval+=.18
            at+=interval;index+=1
        for index,ratio in enumerate([1,1.25,1.5,2]):
            add(8.85+index*.27,note(ratio,.38),.065+index*.012,'charge')
        for at,ratio in [(10.20,1.5),(10.48,1.25),(10.89,1),(11.38,.75)]:
            add(at,note(ratio,.31),.054,'coast')
        add(11.64,note(.5,.24),.085,'land')
        # A short major reward phrase has a definite musical ending.
        intervals=[0,4,7,12,7,16,12] if key=='default1' else [0,7,12,16,19,12] if key=='default2' else [0,4,7,4,12]
        spacing=.14 if key=='default1' else .19 if key=='default2' else .21
        for index,semitone in enumerate(intervals):
            add(11.8+index*spacing,note(2**(semitone/12),.70),.15 if index==len(intervals)-1 else .11,'reveal')
        arrival=11.8+(len(intervals)-1)*spacing
        for ratio,gain in [(1,.055),(1.25,.030),(1.5,.030)]:
            add(arrival+.04,note(ratio,1.05),gain,'reveal-chord')
        # Soft final answer, distinct from the rhythm of motion.
        add(14.30,note(1.5,1.35),.085,'tail')
        result=core.space_tail(result,preset['wet'])
    else:
        root=preset['root'];notes=preset['notes']
        add(0.,stellar_note(root*1.5,.65,.07),.095,'start')
        length=int(11.5*SR);time=np.arange(length)/SR
        motion_gain=np.minimum(time/.65,1)*(.74+.13*np.sin(time*1.2))
        motion_gain*=np.where(time<10.1,1.,np.clip((11.5-time)/1.4,0,1))
        pad=np.sin(2*math.pi*root*time)*motion_gain
        partner=np.sin(2*math.pi*root*1.5*time)*motion_gain*.42
        body=np.stack([pad+partner,pad+partner],axis=1)
        add(.14,core.fades(body,.25,.30),.024 if key=='cosmic1' else .019,'spatial-body')
        at=1.03;index=0
        while at<10.7:
            factor=1 if at<8.8 else max(.35,1-(at-8.8)/2.4)
            duration=.95 if key=='cosmic1' else 1.05 if key=='cosmic2' else 1.35
            attack=.12 if key!='cosmic2' else .045
            partial=.028 if key=='cosmic2' else 0.
            add(at,stellar_note(notes[index%len(notes)],duration,attack,partial),
                .084*factor,'motion',.46*math.sin(at*.65) if key!='cosmic1' else .18*math.sin(at))
            at+=preset['motion']/max(factor,.55);index+=1
        for index,ratio in enumerate([1,1.25,1.5]):
            add(8.90+index*.32,stellar_note(root*ratio*2,1.0,.12),.046,'charge',-.2+index*.2)
        add(10.42,stellar_note(root*1.5,.78,.15),.042,'coast')
        add(11.58,stellar_note(root,.25,.035),.070,'land')
        reveal=[2,2.5,3] if key=='cosmic1' else [2,2.5,3,4] if key=='cosmic2' else [1.5,2,2.5,3]
        for index,ratio in enumerate(reveal):
            add(11.8+index*(.12 if key=='cosmic1' else .19),
                stellar_note(root*ratio,1.8 if key!='cosmic3' else 2.15,.07),.145,'reveal',-.15+index*.1)
        # Leave space after the reveal; no chime-tree, water, or unrelated magic samples.
        if key!='cosmic1':
            for index,ratio in enumerate([1,1.5,2]):
                add(12.38,stellar_note(root*ratio,2.55,.24),.045/(1+index*.4),'reveal-body')
        add(14.18,stellar_note(root*2,1.50,.12),.040,'tail')
        result=core.space_tail(result,preset['wet'])
    result=core.fades(core.lowpass(result,2700 if preset['theme']=='cosmic' else 3600),.008,.55)
    return result,sorted(events,key=lambda event:event['time'])


def main():
    samples,sources=instruments()
    manifest=dict(version='theme-audio-review-1',duration=16,sampleRate=SR,
        themes={'default':{'name':'默认主题','description':'轻快、清楚、有游戏反馈'},
                'cosmic':{'name':'星空主题','description':'空灵、流动、有空间感'}},
        candidates={},phases=core.PHASES,sources=sources,
        sourcePack=dict(url=PACK_URL,sha256=PACK_SHA),
        reviewOnly=True,themeAssignments={'default':None,'cosmic':None})
    for key,preset in PRESETS.items():
        # Old cosmic1-3 arrangements stay below as historical source only.
        # The current stellar candidates are built separately with natural tails.
        if preset['theme']!='default':continue
        audio,events=arrange(key,samples)
        clip=core.export(key,audio,target_lufs=-19)
        manifest['candidates'][key]={field:preset[field] for field in ['theme','name','character','description']}
        manifest['candidates'][key].update(clip=clip,events=events,
            sources=[preset['instrument']] if preset['theme']=='default' else [],
            originalTones='Existing stellar sine palette and envelopes' if preset['theme']=='cosmic' else 'Quiet resonant body under licensed single-note samples')
        print(key,clip['measuredLUFS'],clip['truePeakDbTP'],flush=True)
    (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    credits='Theme-grouped complete audio review\nDefault theme: Kenney Music Jingles, CC0-1.0.\nhttps://kenney.nl/assets/music-jingles\nhttps://creativecommons.org/publicdomain/zero/1.0/\nThree single-note samples extracted, tuned, softened and rearranged. See manifest for exact files and hashes.\nCosmic theme: original project stellar sine palette, new timed arrangements. No sampled third-party audio.\nBuild: scripts/build_theme_audio_review.py\n'
    (OUT/'CREDITS.txt').write_text(credits,encoding='utf-8')
    from build_elegant_stellar_audio_review import build
    build()
    from build_machine_rhythm_review import build as build_rhythm
    build_rhythm()
    print('Written current default and elegant stellar auditions',flush=True)


if __name__=='__main__':
    # Canonical build now publishes only the latest six slot-inspired candidates.
    from build_slot_audio_review import build
    build()
