"""Compose complete review reels from approved soft tones and licensed samples.

This creates audition arrangements, not a production event player. Run with
Python + NumPy and ffmpeg. Network inputs are public author preview files.
"""
from pathlib import Path
import hashlib
import json
import math
import subprocess
import urllib.request
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'static/v7-preview/soft-audio'
CACHE = ROOT / 'artifacts/soft-audio-sources-20260930'
MASTERS = ROOT / 'artifacts/soft-audio-masters-20260930'
for folder in (OUT, CACHE, MASTERS):
    folder.mkdir(parents=True, exist_ok=True)
SR = 48000
DURATION = 16.0
INPUTS = {
    'glow': dict(author='newagesoup', title='GLEAM-GLOW-SFX-CHIME.wav',
        page='https://freesound.org/people/newagesoup/sounds/351408/',
        url='https://cdn.freesound.org/previews/351/351408_4067257-hq.mp3',
        license='CC0-1.0', licenseUrl='https://creativecommons.org/publicdomain/zero/1.0/',
        file='glow-preview.mp3', acquisition='Public author HQ preview; not the original WAV'),
    'water': dict(author='bxyorna', title='Water drop / Splash',
        page='https://freesound.org/people/bxyorna/sounds/410335/',
        url='https://cdn.freesound.org/previews/410/410335_7963426-hq.mp3',
        license='CC0-1.0', licenseUrl='https://creativecommons.org/publicdomain/zero/1.0/',
        file='water-preview.mp3', acquisition='Public author HQ preview; not the original AIFF'),
    'shimmer': dict(author='The Berklee College of Music', uploader='qubodup', title='Shimmer glitter magic',
        page='https://opengameart.org/content/shimmer-glitter-magic',
        url='https://opengameart.org/sites/default/files/shimmer_1.flac',
        license='CC-BY-3.0', licenseUrl='https://creativecommons.org/licenses/by/3.0/',
        file='shimmer.flac', acquisition='Public author-linked FLAC'),
}


def command(args, data=None):
    return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', *args],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def get_sources():
    pin_path = CACHE / 'source-hashes.json'
    pinned = json.loads(pin_path.read_text('utf-8')) if pin_path.exists() else {}
    sounds = {}
    for key, spec in INPUTS.items():
        path = CACHE / spec['file']
        if not path.exists():
            request = urllib.request.Request(spec['url'], headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=40) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError('Unexpectedly large source')
            # Decode before accepting the downloaded input.
            command(['-i', 'pipe:0', '-f', 'null', '-'], raw)
            path.write_bytes(raw)
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if key in pinned and pinned[key] != digest:
            raise ValueError(f'{key}: source changed; review license and content before rebuilding')
        pinned[key] = digest
        spec['sha256'] = digest
        decoded = command(['-i', str(path), '-f', 'f32le', '-ar', str(SR), '-ac', '2', 'pipe:1'])
        sound = np.frombuffer(decoded, np.float32).reshape(-1, 2).astype(np.float64)
        sound -= np.mean(sound, axis=0)
        sound /= max(float(np.max(np.abs(sound))), .001)
        sounds[key] = sound
    pin_path.write_text(json.dumps(pinned, indent=2), encoding='utf-8')
    return sounds


def lowpass(x, hz):
    frequencies = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(np.fft.rfft(x, axis=0) /
        (1 + (frequencies[:, None] / hz) ** 6), n=len(x), axis=0)


def fades(x, attack=.04, release=.15):
    result = x.copy()
    a = min(int(attack * SR), len(x) // 2)
    r = min(int(release * SR), len(x) // 2)
    if a:
        result[:a] *= np.sin(np.linspace(0, math.pi / 2, a))[:, None] ** 2
    if r:
        result[-r:] *= np.cos(np.linspace(0, math.pi / 2, r))[:, None] ** 2
    return result


def pan(x, position):
    # Equal-power movement, with some original stereo retained.
    mono = x.mean(axis=1)
    p = np.broadcast_to(np.clip(position, -1, 1), mono.shape)
    angle = (p + 1) * math.pi / 4
    moved = np.stack([mono * np.cos(angle), mono * np.sin(angle)], axis=1)
    return moved * .8 + x * .2


def sample(x, rate=1., trim=None, cut=3500, attack=.05, release=.18):
    if trim is not None:
        x = x[int(trim[0] * SR):int(trim[1] * SR)]
    n = max(1, int(len(x) / rate))
    at = np.arange(n) * rate
    y = np.stack([np.interp(at, np.arange(len(x)), x[:, channel]) for channel in range(2)], axis=1)
    return fades(lowpass(y, cut), attack, release)


def soft_note(frequency, duration=1.0, attack=.07, glide=1.):
    # Same sine-based character as the approved stellar palette; no hard FM,
    # sawtooth/brass oscillators, collision samples, or percussion loops.
    t = np.arange(int(duration * SR)) / SR
    instantaneous = frequency * (1 + (glide - 1) * np.exp(-t / .11))
    phase = 2 * math.pi * np.cumsum(instantaneous) / SR
    envelope = np.minimum(t / attack, 1) * np.exp(-t * 4.5 / duration)
    y = np.sin(phase) * envelope
    return fades(np.stack([y, y], axis=1), .008, .12)


def space_tail(x, wet=.18):
    result = x.copy()
    for seconds, gain, reverse in [(.13, wet, False), (.27, wet * .63, True),
                                   (.43, wet * .40, False), (.71, wet * .22, True)]:
        offset = int(seconds * SR)
        if offset < len(x):
            source = x[:, ::-1] if reverse else x
            result[offset:] += source[:-offset] * gain
    return result


FAMILIES = {
 'aurora': dict(name='星海空灵', tag='柔和 · 舒展', color='#bba9ef',
    description='保留你认可的柔和音色，星海缓缓展开，揭晓时轻轻绽放。',
    process='柔和和声与空间掠过', reward='清晰三音揭晓，温柔收尾',
    root=196., notes=[392., 493.88, 587.33, 493.88], pad=[196., 293.66],
    interval=1.18, bed=.027, note=.076, glow=.04, water=0., shimmer=.025, tail=.22,
    sources=['glow','shimmer']),
 'starlight': dict(name='星光奇遇', tag='闪耀 · 轻奇幻', color='#ebc990',
    description='现成魔法风铃作为主角，星光逐渐汇聚，揭晓明亮而轻盈。',
    process='魔法风铃与流动星光', reward='一束闪光展开，留下清透余音',
    root=261.63, notes=[523.25, 659.25, 783.99, 659.25], pad=[261.63,392.],
    interval=.95, bed=.020, note=.048, glow=.125, water=0., shimmer=.105, tail=.16,
    sources=['glow','shimmer']),
 'spring': dict(name='星泉流光', tag='水滴 · 流动', color='#89d9d5',
    description='真实水滴融入轻盈音符，涟漪随着运转展开，最后汇成一束光。',
    process='柔化水滴、涟漪与疏落音符', reward='水滴落定，和声与闪光展开',
    root=196., notes=[659.25,493.88,587.33,392.,523.25], pad=[196.,392.],
    interval=1.08, bed=.018, note=.048, glow=.042, water=.17, shimmer=.018, tail=.25,
    sources=['glow','water','shimmer']),
 'moon': dict(name='月光秘境', tag='温暖 · 梦幻', color='#e4adc9',
    description='低而温暖的空间和声，期待缓慢升起，结果像月光一样舒展开。',
    process='温暖低音与舒缓空间流动', reward='宽阔和声、柔和魔法尾音',
    root=174.61, notes=[349.23,440.,523.25,440.], pad=[174.61,261.63],
    interval=1.48, bed=.040, note=.064, glow=.06, water=0., shimmer=.015, tail=.30,
    sources=['glow','shimmer']),
}
MACHINES = {'capsule': '胶囊机', 'wheel': '转盘', 'sphere': '姓名星球'}
PHASES = [dict(id='start', name='启动', start=0., end=.8),
          dict(id='motion', name='运转', start=.8, end=8.8),
          dict(id='charge', name='蓄势', start=8.8, end=10.2),
          dict(id='coast', name='减速', start=10.2, end=11.8),
          dict(id='reveal', name='揭晓', start=11.8, end=14.2),
          dict(id='tail', name='收尾', start=14.2, end=16.)]


def arrange(key, machine, inputs):
    p = FAMILIES[key]
    mix = np.zeros((int(SR * DURATION), 2), np.float64)
    events = []

    def add(start, sound, gain, kind, position=0.):
        offset = int(start * SR)
        n = min(len(sound), len(mix) - offset)
        if n <= 0:
            return
        mix[offset:offset+n] += pan(sound[:n], position) * gain
        events.append(dict(time=round(start,3), kind=kind, gain=round(gain,4)))

    # Warm spatial body with a controlled rise and a real drop before reveal.
    length = int(11.55 * SR)
    t = np.arange(length) / SR
    envelope = np.minimum(t / .8, 1.) * (.74 + .16 * np.sin(t * .9) ** 2)
    envelope *= np.where(t < 8.8, .66 + .34 * np.minimum(t / 8.8, 1),
                         np.where(t < 10.1, 1.0, np.clip((11.55-t)/1.45, 0, 1)))
    body = np.zeros((length, 2))
    for index, frequency in enumerate(p['pad']):
        fundamental = np.sin(2 * math.pi * frequency * t + .002 * np.sin(t * 1.6))
        harmonic = np.sin(2 * math.pi * frequency * 2 * t) * .07
        mono = (fundamental + harmonic) * envelope * (1 if index == 0 else .62)
        body += pan(np.stack([mono,mono],axis=1), .28 * np.sin(t*.8 + index))
    add(.12, fades(body,.4,.3), p['bed'], 'spatial-body')
    add(0., soft_note(p['root']*2,.42,.035), p['note']*.52, 'press')
    add(.20, soft_note(p['root']*1.5,.76,.13,.90), p['note']*.46, 'start')
    add(.13, sample(inputs['glow'],rate=1.12,trim=(.12,1.15),cut=2500), p['glow']*.47,'start-glimmer',-.22)

    rng = np.random.default_rng(410335 + list(FAMILIES).index(key)*10 + list(MACHINES).index(machine))
    at = .95
    index = 0
    while at < 10.8:
        speed = .8 + .20 * np.minimum(at/7.2,1) if at < 8.8 else max(.2, 1-(at-8.8)/2.6)
        if machine == 'capsule':
            interval = p['interval']*.50 / max(speed,.38) * rng.uniform(.80,1.20)
            duration = .50 + .14 * rng.random()
            position = float(rng.uniform(-.64,.64))
            level = p['note']*.32
            frequency = p['notes'][index % len(p['notes'])] * .5
            kind = 'capsule-soft-motion'
        elif machine == 'wheel':
            interval = p['interval']*.45 / max(speed,.30)
            duration = .34
            position = .30 * math.sin(at*1.1)
            level = p['note']*.28
            frequency = p['notes'][index % len(p['notes'])] * .75
            kind = 'wheel-soft-pass'
        else:
            interval = p['interval']*1.18 / max(speed,.48)
            duration = 1.12
            position = .65*math.sin(at*.72)
            level = p['note']*.72
            frequency = p['notes'][index % len(p['notes'])]
            kind = 'sphere-space-pass'
        add(at,soft_note(frequency,duration,.065 if machine!='sphere' else .14,
                        1.08 if key=='spring' else 1.), level*max(.52,speed),kind,position)
        if key=='spring' and index%2==0:
            add(at+.04,sample(inputs['water'], rate=.9 + index%3*.08,cut=2100,
                             attack=.022,release=.20),p['water']*(.29 if machine!='sphere' else .38),
                'water-ripple',-position)
        at += interval
        index += 1

    # Sparse real textures, never a dense stack of repeating reveal recordings.
    for index,at in enumerate([1.25,4.45,7.50]):
        rate = .82 if key=='moon' else 1.15 if key=='starlight' else 1.
        sparkle = sample(inputs['glow'],rate=rate,trim=(.65,3.4),
                         cut=3100 if key=='starlight' else 2100,attack=.22,release=.40)
        moving = .54 * np.sin(np.linspace(-math.pi/2,math.pi/2,len(sparkle))) * (-1 if index%2 else 1)
        add(at,sparkle,p['glow']*.52,'glimmer-pass',moving)

    # Short ascending expectation, deceleration, and a small pocket of quiet.
    for i,ratio in enumerate([1,1.125,1.25,1.5]):
        add(8.75+i*.26,soft_note(p['root']*ratio*2,.90,.09),
            p['note']*(.46+i*.06),'anticipation',-.25+i*.16)
    add(10.35,soft_note(p['root']*1.5,.85,.13),p['note']*.27,'coast')
    if key=='spring':
        add(11.55,sample(inputs['water'],rate=.85,cut=2300),p['water']*.48,'water-landing')
    else:
        add(11.58,soft_note(p['root'],.36,.035),p['note']*.48,'soft-landing')
    # All versions share the same reveal timestamp for fair comparison.
    for index,ratio in enumerate([2,2.5,3]):
        add(11.80+index*.13,soft_note(p['root']*ratio,2.25,.07),p['note']*1.12,
            'reveal-note',-.12+index*.12)
    for ratio,gain in [(1,.60),(1.5,.35),(2,.25)]:
        add(12.08,soft_note(p['root']*ratio,3.3,.23),p['note']*gain,'reveal-body')
    add(11.84,sample(inputs['shimmer'],rate=.92 if key=='starlight' else .76,
                    cut=3500 if key=='starlight' else 2200,attack=.016,release=.13),
        p['shimmer'],'reveal-flash')
    add(12.04,sample(inputs['glow'],rate=1.12 if key=='starlight' else .90,
                    trim=(.1,3.15),cut=3400 if key=='starlight' else 2500,
                    attack=.12,release=.48),p['glow']*.83,'reveal-glimmer',.12)
    mix = space_tail(mix,p['tail'])
    mix = fades(lowpass(mix,4200 if key=='starlight' else 3200),.008,.85)
    return mix, sorted(events,key=lambda e:e['time'])


def measure(path):
    run = subprocess.run(['ffmpeg','-hide_banner','-i',str(path),'-af',
        'loudnorm=I=-18:TP=-1.5:LRA=9:print_format=json','-f','null','-'],
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
    output=run.stderr.decode('utf-8','replace')
    return json.loads(output[output.rfind('{'):output.rfind('}')+1])


def export(name,audio,target_lufs=-18):
    raw = audio.astype(np.float32).tobytes()
    analysis = subprocess.run(['ffmpeg','-hide_banner','-f','f32le','-ar',str(SR),
        '-ac','2','-i','pipe:0','-af',f'loudnorm=I={target_lufs}:TP=-1.5:LRA=9:print_format=json',
        '-f','null','-'],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
    log=analysis.stderr.decode('utf-8','replace')
    stats=json.loads(log[log.rfind('{'):log.rfind('}')+1])
    target=('loudnorm=I='+str(target_lufs)+':TP=-1.5:LRA=9:measured_I={input_i}:measured_TP={input_tp}:measured_LRA={input_lra}:measured_thresh={input_thresh}:offset={target_offset}:linear=true').format(**stats)
    mastered = command(['-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0',
        '-af',target,'-f','f32le','-ar',str(SR),'-ac','2','pipe:1'],raw)
    path=OUT/(name+'.mp3')
    command(['-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0',
        '-c:a','libmp3lame','-b:a','192k','-y',str(path)],mastered)
    final=measure(path)
    # Encoded peaks can differ from the PCM master; align the actual deliverable.
    correction=min(target_lufs-float(final['input_i']),-1.7-float(final['input_tp']))
    if abs(correction)>.025:
        mastered=command(['-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0',
            '-af',f'volume={correction}dB','-f','f32le','-ar',str(SR),'-ac','2','pipe:1'],mastered)
        command(['-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0',
            '-c:a','libmp3lame','-b:a','192k','-y',str(path)],mastered)
        final=measure(path)
    if name.endswith('-capsule'):
        command(['-f','f32le','-ar',str(SR),'-ac','2','-i','pipe:0',
            '-c:a','pcm_s16le','-y',str(MASTERS/(name+'.wav'))],mastered)
    decoded=np.frombuffer(command(['-i',str(path),'-f','f32le','-ar',str(SR),'-ac','2','pipe:1']),np.float32).reshape(-1,2)
    # Record activity per phase, so a complete file cannot pass with a silent process.
    levels={phase['id']:round(20*np.log10(max(float(np.sqrt(np.mean(
        decoded[int(phase['start']*SR):int(phase['end']*SR)]**2))),1e-9)),2) for phase in PHASES}
    return dict(url='./'+OUT.relative_to(ROOT/'static/v7-preview').as_posix()+'/'+path.name,duration=16,
        measuredLUFS=float(final['input_i']),truePeakDbTP=float(final['input_tp']),
        phaseRmsDbfs=levels,bytes=path.stat().st_size,
        sha256=hashlib.sha256(path.read_bytes()).hexdigest())


def main():
    inputs=get_sources()
    manifest=dict(version='soft-audio-review-1',sampleRate=SR,duration=DURATION,
        phases=PHASES,machines=MACHINES,candidates={},sources=INPUTS,
        themeAssignments={'default':None,'cosmic':None},
        arrangement='Existing stellar sine character plus licensed sample edits. Trim, filtering, speed change, spatial movement, fades and layered arrangement. All source material modified.',
        reviewOnly=True)
    for key,p in FAMILIES.items():
        entry={k:p[k] for k in ['name','tag','color','description','process','reward','sources']}
        entry['clips']={}
        for machine in MACHINES:
            audio,events=arrange(key,machine,inputs)
            entry['clips'][machine]=export(key+'-'+machine,audio)
            entry['clips'][machine]['events']=events
            print(key,machine,entry['clips'][machine]['measuredLUFS'],entry['clips'][machine]['truePeakDbTP'],flush=True)
        manifest['candidates'][key]=entry
    (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    credits=['Complete soft audio review — 2026-09-30',
        'All source samples modified: trimming, filtering, speed, spatial mix, envelopes and arrangement.',
        'Original soft sine voices and arrangement: lottery-platform/scripts/build_soft_audio_review.py', '']
    for key,source in INPUTS.items():
        credits += [source['title']+' — '+source['author'],source['page'],
            source['license']+' — '+source['licenseUrl'],source['acquisition'],
            'SHA256: '+source['sha256'],'']
    (OUT/'CREDITS.txt').write_text('\n'.join(credits),encoding='utf-8')
    print('Complete:',len(list(OUT.glob('*.mp3'))),'16-second arrangements',flush=True)


if __name__=='__main__':
    main()
