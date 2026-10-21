"""Six slot-inspired auditions and event assets. Python + NumPy + ffmpeg.

Current revision uses only the original pitched arcade/bell instruments.
Historical rejected reels remain on disk; publish the manifest only at the end.
"""
from pathlib import Path
import json
import math
import numpy as np
import build_soft_audio_review as core
import build_elegant_stellar_audio_review as encoding

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'static/v7-preview/theme-audio'
CACHE = ROOT / 'artifacts/slot-audio-sources-20260930'
SR = core.SR
REVISION = 'slot-review-3'
PRESETS = {
 'slot-default1': dict(theme='default', name='默认方案一', character='经典叮当',
  description='清楚的铃声跟随转动，停稳一声确认，最后一串明亮叮当。',
  voice='brass-bell', root=60, wet=.065, tone=.54, cutoff=4100),
 'slot-default2': dict(theme='default', name='默认方案二', character='霓虹街机',
  description='电子音符由疏到密，停下时干脆确认，短促街机旋律庆祝揭晓。',
  voice='arcade', root=57, wet=.07, tone=.62, cutoff=3700),
 'slot-default3': dict(theme='default', name='默认方案三', character='糖果弹珠',
  description='圆润的弹跳短音随转动起伏，减速逐渐变疏，揭晓轻快有弹性。',
  voice='bubble', root=62, wet=.055, tone=.62, cutoff=3500),
 'slot-cosmic1': dict(theme='cosmic', name='星空方案一', character='星铃幸运',
  description='星铃跟着转动轻轻敲响，落定后展开一小串有空间感的幸运铃。',
  voice='glass', root=65, wet=.16, tone=.54, cutoff=3900),
 'slot-cosmic2': dict(theme='cosmic', name='星空方案二', character='银河流转',
  description='柔和的电子音符随转速起伏，节奏逐渐变疏，清透短句揭晓。',
  voice='orbit', root=63, wet=.20, tone=.48, cutoff=3400),
 'slot-cosmic3': dict(theme='cosmic', name='星空方案三', character='极光礼赞',
  description='晶莹音符随减速逐渐收拢，揭晓时一束和声明亮展开。',
  voice='aurora', root=61, wet=.22, tone=.48, cutoff=3300),
}


def zeros(seconds):
    return np.zeros((round(seconds * SR), 2))


def peak(sound, target):
    return sound * 10 ** (target / 20) / max(float(np.max(np.abs(sound))), 1e-8)


def place(target, sound, at, gain=1., position=0.):
    begin = round(at * SR)
    count = min(len(sound), len(target)-begin)
    if count > 0:
        target[begin:begin+count] += core.pan(sound[:count], position) * gain


def retune(sound, rate=1., seconds=None):
    count = round(seconds * SR) if seconds is not None else round(len(sound)/rate)
    at = np.arange(count) * rate
    return np.stack([np.interp(at, np.arange(len(sound)), sound[:,c], left=0, right=0) for c in range(2)], axis=1)


def tone(midi, duration, voice):
    """Original game instruments, not the previous sparse piano/pad palette."""
    f = 440*2**((midi-69)/12)
    t = np.arange(round(duration*SR))/SR
    ph = 2*np.pi*f*t
    decay = .21 if duration < .4 else .58
    if voice == 'brass-bell':
        y = np.sin(ph)*np.exp(-t/decay) + .35*np.sin(ph*2.76)*np.exp(-t/.12) + .11*np.sin(ph*5.4)*np.exp(-t/.07)
    elif voice == 'arcade':
        y = np.sin(ph + 1.9*np.exp(-t/.035)*np.sin(2*ph))*np.exp(-t/decay)
        y += .16*np.sin(ph/2)*np.exp(-t/.13)
    elif voice == 'bubble':
        phase = ph + 2*np.pi*f*.018*(1-np.exp(-t/.018))
        y = (np.sin(phase)+.27*np.sin(phase*2))*np.exp(-t/(decay*.65))
    elif voice == 'glass':
        y = np.sin(ph)*np.exp(-t/(decay*1.2))+.23*np.sin(ph*3.01)*np.exp(-t/.20)+.08*np.sin(ph*6.02)*np.exp(-t/.10)
    elif voice == 'orbit':
        y = np.sin(ph+.68*np.exp(-t/.16)*np.sin(ph*2))*np.exp(-t/(decay*1.45))
        y += .12*np.sin(ph*1.002)*np.exp(-t/.65)
    else:
        y = np.sin(ph+.32*np.sin(ph*3)*np.exp(-t/.15))*np.exp(-t/(decay*1.7))
        y += .14*np.sin(ph*2.005)*np.exp(-t/.38)
    y *= 1-np.exp(-t/.004)
    return core.fades(np.stack([y,y],axis=1),.003,min(.14,duration*.35))


def room(sound, wet):
    # Short diffuse reflections: no long echo train over the physical reel ticks.
    return encoding.room(sound, .75+wet*3, wet, 93026)


def arrange(key,p):
    cosmic=p['theme']=='cosmic'
    root=p['root']
    def note(semitone,duration=.5):
        return tone(root+semitone,duration,p['voice'])
    pulse=zeros(.13 if not cosmic else .17)
    place(pulse,note(0,len(pulse)/SR),0,p['tone'])
    pulse=peak(core.lowpass(core.fades(pulse,.003,.03),p['cutoff']),-14.5 if not cosmic else -16)
    start=zeros(.9)
    for at,interval,gain in [(0,0,.23),(.10,7,.19),(.22,12,.21)]:
        place(start,note(interval,.6),at,gain)
    start=peak(room(start,p['wet']*.5),-10.5)
    stop=zeros(.65)
    place(stop,note(0 if cosmic else -12,.48),0,.25 if cosmic else .3)
    place(stop,note(7,.45),.045,.12)
    stop=peak(room(stop,p['wet']*.4),-11.5)
    reveal=zeros(4.2)
    melodies={
      'brass-bell':[(0,0),(.115,4),(.23,7),(.42,12),(.82,7),(1.04,12)],
      'arcade':[(0,0),(.10,7),(.20,12),(.35,16),(.62,12),(.87,19),(1.04,12)],
      'bubble':[(0,0),(.15,4),(.30,7),(.49,12),(.80,7),(1.08,12)],
      'glass':[(0,0),(.16,7),(.32,12),(.58,16),(.86,19),(1.12,12)],
      'orbit':[(0,0),(.18,7),(.42,14),(.66,16),(.96,12),(1.28,7)],
      'aurora':[(0,0),(.20,4),(.42,7),(.70,14),(1.00,12)],
    }
    for at,interval in melodies[p['voice']]:
        place(reveal,note(interval,1.8 if cosmic else 1.15),at,.21 if at==0 else .18,.13*math.sin(at*4))
    arrival=melodies[p['voice']][-1][0]
    chord=[(0,.08),(7,.06),(12,.045),(16,.035)] if cosmic else [(-12,.10),(0,.085),(4,.060),(7,.060)]
    for interval,gain in chord:
        place(reveal,note(interval,2.6),arrival+.04,gain)
    place(reveal,note(12,1.8),2.30,.055)
    reveal=peak(core.fades(core.lowpass(room(reveal,p['wet']),p['cutoff']),.003,.50),-6.0)
    parts=dict(start=start,pulse=pulse,stop=stop,reveal=reveal)
    full=zeros(16)
    events=[dict(time=0,kind='start'),dict(time=11.8,kind='reveal')]
    place(full,start,0)
    # Reference performance only. The 3D page uses real event cadence/rate.
    t=np.arange(round(11.65*SR))/SR
    speed=np.where(t<1.1,np.clip(t/1.1,0,1),np.where(t<8.8,1,np.clip(1-(t-8.8)/2.8,0,1)**1.7))
    cursor=.16
    index=0
    while cursor<11.5:
        s=float(speed[min(round(cursor*SR),len(speed)-1)])
        if s<.045:break
        rate=[1,1,2**(7/12),1][index%4]
        place(full,retune(pulse,rate),cursor,.70 if not cosmic else .62,(-1)**index*.10)
        events.append(dict(time=round(cursor,3),kind='motion' if cursor<8.8 else 'coast'))
        cursor+=.105+(.62*(1-s)**2)
        index+=1
    place(full,stop,11.62)
    events.append(dict(time=11.62,kind='land'))
    place(full,reveal,11.8)
    return core.fades(full,.003,.35),parts,sorted(events,key=lambda e:e['time'])


def build(cosmic_only=False):
    OUT.mkdir(parents=True,exist_ok=True)
    CACHE.mkdir(parents=True,exist_ok=True)
    old=OUT/'manifest.json'
    archive=CACHE/'rejected-manifest.json'
    if old.exists() and not archive.exists():archive.write_bytes(old.read_bytes())
    previous=json.loads(old.read_text('utf-8')) if cosmic_only else None
    if cosmic_only:
        assert all(key in previous['candidates'] for key,p in PRESETS.items() if p['theme']=='default')
    manifest=dict(version=REVISION,motionRevision='slot-motion-1',duration=16,sampleRate=SR,
        themes={'default':dict(name='默认主题',description='经典叮当 · 霓虹街机 · 糖果弹珠'),
                'cosmic':dict(name='星空主题',description='星铃幸运 · 银河流转 · 极光礼赞')},
        candidates={},phases=core.PHASES,sources={},
        reviewOnly=True,
        themeAssignments={'default':None,'cosmic':None},
        references=[dict(url='https://sonniss.com/sound-effects/progressive-slots-classic-fruit-machines-sound-effects-library-casino-slot-game-royalty-free-sounds-audio-pack/',
                         usage='Event vocabulary and reel/start/stop/reward structure only; no commercial audio downloaded or copied')])
    for key,p in PRESETS.items():
        if cosmic_only and p['theme']=='default':
            manifest['candidates'][key]=previous['candidates'][key]
            continue
        full,parts,events=arrange(key,p)
        stats=encoding.loudness(full)
        gain=min(-19-float(stats['input_i']),-2.0-float(stats['input_tp']))
        suffix='-v3'
        clip=encoding.encode(key+suffix,full,gain,phases=True)
        clips={name:encoding.encode(key+suffix+'-'+name,audio,gain) for name,audio in parts.items()}
        entry={field:p[field] for field in ['theme','name','character','description']}
        entry.update(clip=clip,slotClips=clips,events=events,revision=REVISION,
            sources=[],originalTones='Original arcade FM, modal bell and resonant pop instruments; pitched rhythm only, no foley or noise bed',
            design=dict(layers=['start','pulse','stop','reveal'],physicalSpeed=True,physicalStop=True,physicalReveal=True,noMotorHum=True,noFoley=True,continuousRoll=False),
            playback=dict(rollEnabled=False,rollLevel=0,rhythmLevel=.90 if p['theme']=='default' else .82,
                          rateMin=.55,rateMax=1.50,cutoffMin=650,cutoffMax=p['cutoff'],
                          pulseRates=[1,1,2**(7/12),1],crossfadeSeconds=.12))
        manifest['candidates'][key]=entry
        print(key,p['character'],clip['measuredLUFS'],clip['truePeakDbTP'],flush=True)
    old.write_text(json.dumps(manifest,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (OUT/'CREDITS.txt').write_text("""Slot-inspired audio review 3
Both themes: original pitched arcade FM, modal bell and resonant pop instruments.
All continuous rolling/friction layers and sampled chip/card impacts removed.
No sampled or stochastic sound source is scheduled in the current arrangements.
Short diffuse reverb processes tonal notes only; it is not a separate noise bed.
Physical crossings/impacts trigger musical rhythm. No ambient loop is loaded.

Historical CC0 Kenney files and credits are retained on disk, but the current six
candidates do not use them. Previous audio versions remain historical.

Design reference only: FUSEHIVE Progressive Slots and Classic Fruit Machines.
No paid audio acquired or copied.
https://sonniss.com/sound-effects/progressive-slots-classic-fruit-machines-sound-effects-library-casino-slot-game-royalty-free-sounds-audio-pack/

Build: python scripts/build_slot_audio_review.py
This is a preview; production theme assignments remain null.
""",encoding='utf-8')


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument('--cosmic-only',action='store_true',help='Preserve accepted default assets and metadata exactly')
    build(cosmic_only=parser.parse_args().cosmic_only)
