"""Three original, spacious stellar scores, plus separate adaptive game stems.

No downloads or production changes. Preserve default candidates byte-for-byte.
Rebuild with Python + NumPy + ffmpeg. Previous stellar files remain available.
"""
from pathlib import Path
import hashlib
import json
import math
import subprocess
import numpy as np
import build_soft_audio_review as core

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'static/v7-preview/theme-audio'
ARCHIVE = ROOT / 'artifacts/stellar-elegance-20260930'
SR = core.SR
REVISION = 'stellar-elegant-2'
PRESETS = {
    'cosmic4': dict(theme='cosmic', name='星空方案一', character='月光留白',
        description='柔和琴音，疏落留白；像月光慢慢落下，揭晓轻轻展开。',
        instrument='felt', room=2.35, wet=.25, motionNotes=5,
        gesture='Soft piano-like harmonics, open F add9 voicing, sparse phrases'),
    'cosmic5': dict(theme='cosmic', name='星空方案二', character='流萤轻舞',
        description='轻盈拨弦，星点流转；过程有轻柔起伏，落定后留一缕余光。',
        instrument='harp', room=2.65, wet=.29, motionNotes=7,
        gesture='Rounded harp-like modal plucks, E-flat pentatonic, gentle flowing phrases'),
    'cosmic6': dict(theme='cosmic', name='星空方案三', character='极光柔幕',
        description='丝绒般的和声缓缓舒展；星海聚拢，结果从柔光中浮现。',
        instrument='veil', room=2.9, wet=.33, motionNotes=3,
        gesture='Slow harmonic veils, D-flat major ninth, restrained single-note glints'),
}


def hz(midi):
    return 440. * 2 ** ((midi - 69) / 12)


def pluck(frequency, duration=2.4, kind='felt'):
    """Rounded attack and independently decaying harmonics, no bright click layer."""
    t = np.arange(int(duration * SR)) / SR
    weights = [1., .23, .07, .019, .006] if kind == 'felt' else [1., .31, .135, .046, .016]
    signal = np.zeros_like(t)
    for i, weight in enumerate(weights):
        harmonic = i + 1
        stretch = math.sqrt(1 + (.000045 if kind == 'felt' else .000013) * harmonic ** 2)
        decay = duration * (.36 if kind == 'felt' else .43) / (1 + i * .48)
        partial = np.sin(2 * math.pi * frequency * harmonic * stretch * t)
        signal += weight * partial * np.exp(-t / decay)
    # A restrained, continuously moving stereo image; no hard left/right jumps.
    signal *= (1 - np.exp(-t / (.035 if kind == 'felt' else .025)))
    return core.fades(np.stack([signal, signal], axis=1), .012, .5)


def veil(midis, duration, attack=.9, release=1.1):
    t = np.arange(int(duration * SR)) / SR
    body = np.zeros((len(t), 2))
    for index, midi in enumerate(midis):
        f = hz(midi)
        # Sub-cent organic movement, much slower than a vibrato/chorus effect.
        phase = 2 * math.pi * f * t + .028 * np.sin(2 * math.pi * .19 * t + index)
        mono = np.sin(phase) + .115 * np.sin(2 * phase + .11) + .026 * np.sin(3 * phase)
        mono *= (.93 + .07 * np.sin(t * .7 + index)) / (1 + index * .25)
        body += core.pan(np.stack([mono, mono], axis=1), (index - (len(midis)-1)/2) * .14)
    return core.fades(body, attack, release) / math.sqrt(len(midis))


def room(sound, decay, wet, seed):
    """Dense decaying reflections instead of the previous audible ping-pong echoes."""
    rng = np.random.default_rng(seed)
    count = int(decay * SR)
    t = np.arange(count) / SR
    impulse = rng.normal(size=(count, 2))
    impulse = core.lowpass(impulse, 3200)
    envelope = np.clip((t - .032) / .055, 0, 1) * np.exp(-6.91 * t / decay)
    impulse *= envelope[:, None]
    impulse /= np.sqrt(np.sum(impulse ** 2, axis=0))[None, :]
    size = 1 << (len(sound) + count - 2).bit_length()
    tail = np.fft.irfft(np.fft.rfft(sound, n=size, axis=0) * np.fft.rfft(impulse, n=size, axis=0), n=size, axis=0)[:len(sound)]
    result = sound + tail * wet
    for at, gain in [(.037, .09), (.061, .06), (.089, .035)]:
        offset = int(at * SR)
        result[offset:] += sound[:-offset, ::-1] * gain
    return core.lowpass(result, 3700)


def arrange(key):
    p = PRESETS[key]
    # Motion extends past the nominal boundary, so adaptive transitions never
    # loop across a cut in a pitched note. The tail is faded when coast begins.
    stems = {'motion': np.zeros((int(12.8 * SR), 2)),
             'coast': np.zeros((int(4.5 * SR), 2)),
             'reveal': np.zeros((int(4.2 * SR), 2))}
    events = []
    origins = {'motion': 0, 'coast': 8.8, 'reveal': 11.8}

    def add(stem, at, sound, gain, kind, position=0.):
        target = stems[stem]
        begin = int(at * SR)
        count = min(len(sound), len(target)-begin)
        if count > 0:
            target[begin:begin+count] += core.pan(sound[:count], position) * gain
        events.append(dict(time=round(at + origins[stem], 3), kind=kind, gain=round(gain, 4)))

    def note(stem, at, midi, gain, kind, duration=2.35, position=0.):
        add(stem, at, pluck(hz(midi), duration, 'harp' if key == 'cosmic5' else 'felt'), gain, kind, position)

    if key == 'cosmic4':
        note('motion', 0, 65, .071, 'start', 2.1, -.08)
        note('motion', .28, 72, .034, 'start', 2.1, .1)
        add('motion', .15, veil([53, 60, 67], 10.5, 1.1, 2.4), .010, 'spatial-body')
        for at, midi, gain, pan in [(1.40, 69, .078, -.12), (3.05, 67, .060, .11),
                (4.65, 72, .064, .17), (6.25, 74, .049, -.15), (7.85, 69, .062, .04)]:
            note('motion', at, midi, gain, 'motion', 2.7, pan)
        note('coast', .04, 67, .043, 'charge', 2.8, -.09)
        note('coast', .52, 72, .033, 'charge', 2.8, .10)
        add('coast', 0, veil([60, 67, 69], 3.3, .7, 1.6), .011, 'charge-bed')
        note('coast', 1.63, 65, .037, 'coast', 2.2)
        for at, midi, gain in [(0, 53, .050), (.055, 60, .032), (.16, 69, .055), (.34, 74, .042)]:
            note('reveal', at, midi, gain, 'reveal', 3.8, -.10 + at*.5)
        add('reveal', 0, veil([60, 65, 69, 74], 4.2, .38, 1.5), .019, 'reveal-body')
        note('reveal', 1.3, 72, .046, 'reveal-answer', 2.8, .05)
        note('reveal', 2.5, 69, .019, 'tail', 1.7, -.07)
    elif key == 'cosmic5':
        note('motion', 0, 63, .071, 'start', 2.3, -.09)
        note('motion', .27, 70, .042, 'start', 2.0, .09)
        add('motion', .10, veil([55, 63, 70], 10.6, 1.0, 2.4), .008, 'spatial-body')
        for index, (at, midi) in enumerate([(1.20, 67), (2.30, 70), (3.40, 72),
                (4.65, 70), (5.55, 75), (6.70, 72), (7.80, 67)]):
            note('motion', at, midi, .054 if index%3 else .073, 'motion', 2.5, .18*math.sin(index*1.3))
        note('coast', .06, 70, .045, 'charge', 2.6, -.12)
        note('coast', .57, 75, .039, 'charge', 2.5, .09)
        add('coast', .0, veil([58, 65, 70], 3.6, .75, 1.7), .009, 'charge-bed')
        note('coast', 1.7, 67, .034, 'coast', 2.2, .04)
        for at, midi, gain in [(0, 63, .067), (.23, 70, .048), (.53, 77, .044), (.82, 79, .025)]:
            note('reveal', at, midi, gain, 'reveal', 3.3, -.13 + at*.3)
        add('reveal', 0, veil([55, 63, 70, 77], 4.2, .45, 1.4), .014, 'reveal-body')
        note('reveal', 1.75, 75, .044, 'reveal-answer', 2.4, .04)
        note('reveal', 2.55, 70, .018, 'tail', 1.6, -.07)
    else:
        add('motion', 0, veil([49, 56, 63, 65], 5.3, 1.05, 2.0), .043, 'start')
        add('motion', 3.8, veil([53, 60, 65, 68], 5.0, 1.4, 1.8), .036, 'spatial-body')
        add('motion', 7.1, veil([56, 61, 65, 68], 4.1, 1.1, 2.1), .030, 'spatial-body')
        for at, midi in [(1.8, 68), (4.95, 65), (7.65, 73)]:
            note('motion', at, midi, .032, 'motion', 2.7, .12*math.sin(at*.5))
        add('coast', 0, veil([56, 63, 68, 70], 3.9, .65, 1.8), .030, 'charge-bed')
        note('coast', .25, 68, .025, 'charge', 2.7, -.07)
        note('coast', 1.7, 63, .022, 'coast', 2.5, .08)
        add('reveal', 0, veil([49, 56, 65, 75], 4.2, .42, 1.45), .058, 'reveal')
        note('reveal', .03, 73, .047, 'reveal-light', 3.2, -.05)
        note('reveal', .92, 68, .029, 'reveal-answer', 2.8, .11)
        note('reveal', 2.5, 65, .018, 'tail', 1.7, -.05)

    for index, (name, sound) in enumerate(stems.items()):
        stems[name] = core.fades(room(sound, p['room'], p['wet'], 260930 + index + int(key[-1])*10), .016, .68)
    full = np.zeros((16 * SR, 2))
    for name, sound in stems.items():
        offset = int(origins[name] * SR)
        count = min(len(sound), len(full)-offset)
        # Match the overlap used by the preview's stem crossfade.
        sound = sound.copy()
        boundary = 8.8 if name == 'motion' else 3 if name == 'coast' else 4.2
        end = min(len(sound), int((boundary+.48)*SR))
        if boundary < len(sound)/SR:
            begin = int(boundary*SR)
            sound[begin:end] *= np.cos(np.linspace(0, math.pi/2, end-begin))[:, None]**2
            sound[end:] = 0
        full[offset:offset+count] += sound[:count]
    return core.fades(full, .016, .68), stems, sorted(events, key=lambda event:event['time'])


def loudness(audio):
    run = subprocess.run(['ffmpeg', '-hide_banner', '-f', 'f32le', '-ar', str(SR),
        '-ac', '2', '-i', 'pipe:0', '-af', 'loudnorm=I=-19:TP=-1.5:LRA=9:print_format=json',
        '-f', 'null', '-'], input=audio.astype(np.float32).tobytes(), stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True)
    log = run.stderr.decode('utf-8', 'replace')
    return json.loads(log[log.rfind('{'):log.rfind('}')+1])


def encode(name, audio, gain_db, phases=False):
    path = OUT / (name + '.mp3')
    raw = audio.astype(np.float32).tobytes()
    core.command(['-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', 'pipe:0',
        '-af', f'volume={gain_db}dB', '-c:a', 'libmp3lame', '-b:a', '192k', '-y', str(path)], raw)
    stats = core.measure(path)
    if float(stats['input_tp']) > -1.7:
        gain_db += -1.7 - float(stats['input_tp'])
        core.command(['-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', 'pipe:0',
            '-af', f'volume={gain_db}dB', '-c:a', 'libmp3lame', '-b:a', '192k', '-y', str(path)], raw)
        stats = core.measure(path)
    level = float(stats['input_i'])
    # EBU integrated loudness has a minimum block length. A short action cue
    # may report -inf; represent that unavailable measurement as JSON null.
    result = dict(url='./theme-audio/'+path.name, duration=round(len(audio)/SR, 3),
        measuredLUFS=level if math.isfinite(level) else None, truePeakDbTP=float(stats['input_tp']),
        bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    if phases:
        decoded = np.frombuffer(core.command(['-i', str(path), '-f', 'f32le', '-ar', str(SR), '-ac', '2', 'pipe:1']), np.float32).reshape(-1, 2)
        result['phaseRmsDbfs'] = {p['id']: round(20*np.log10(max(float(np.sqrt(np.mean(
            decoded[int(p['start']*SR):int(p['end']*SR)]**2))), 1e-9)), 2) for p in core.PHASES}
    return result


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    path = OUT/'manifest.json'
    manifest = json.loads(path.read_text('utf-8'))
    if manifest.get('version') != REVISION:
        archive = ARCHIVE/'previous-manifest.json'
        if not archive.exists():
            archive.write_bytes(path.read_bytes())
    defaults = {key: value for key, value in manifest['candidates'].items() if value['theme']=='default'}
    default_hashes = {key: hashlib.sha256((OUT/Path(value['clip']['url']).name).read_bytes()).hexdigest() for key, value in defaults.items()}
    candidates = dict(defaults)
    for key, preset in PRESETS.items():
        full, stems, events = arrange(key)
        stats = loudness(full)
        gain = min(-19-float(stats['input_i']), -1.85-float(stats['input_tp']))
        clip = encode(key+'-elegant-v2', full, gain, phases=True)
        # All three runtime stems share the complete score's gain; they are not
        # separately loudness-normalized (which would inflate the quiet coast).
        adaptive = {name: encode(key+'-elegant-v2-'+name, audio, gain) for name, audio in stems.items()}
        candidates[key] = {name:preset[name] for name in ['theme', 'name', 'character', 'description']}
        candidates[key].update(clip=clip, adaptiveClips=adaptive, events=events, sources=[],
            revision=REVISION, originalTones='Original stellar sine/harmonic palette, newly modeled soft instrument envelopes and diffuse room; no sampled third-party audio',
            design=dict(gesture=preset['gesture'], motionNoteCount=preset['motionNotes'],
                denseReverb=True, hardLandingHit=False, discretePingPongEcho=False),
            playback=dict(crossfadeSeconds=.48, fadeInSeconds=.12, sustainLoop=False))
        print(key, preset['character'], clip['measuredLUFS'], clip['truePeakDbTP'], flush=True)
    assert default_hashes == {key: hashlib.sha256((OUT/Path(value['clip']['url']).name).read_bytes()).hexdigest() for key, value in defaults.items()}
    manifest.update(version=REVISION, candidates=candidates,
        stellarRevision=dict(id=REVISION, replaces=['cosmic1','cosmic2','cosmic3'],
            description='Three elegant variants; previous approvals do not transfer to new audio.'))
    manifest['themes']['cosmic']['description']='月光留白 · 流萤轻舞 · 极光柔幕'
    # Write the manifest last, after every new asset has been encoded and measured.
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    (OUT/'CREDITS.txt').write_text('Theme-grouped audio review\nDefault candidates unchanged: Kenney Music Jingles, CC0-1.0.\nhttps://kenney.nl/assets/music-jingles\nhttps://creativecommons.org/publicdomain/zero/1.0/\nDefault source details: manifest sources and original source-pack hashes.\nStellar elegant revision 2: original additive/modal synthesis and deterministic diffuse convolution, no sampled third-party audio.\nPiano-like and harp-like are synthesized timbres, not recordings of acoustic instruments.\nThree separate motion/coast/reveal stems share each score master gain.\nBuild stellar only: python scripts/build_elegant_stellar_audio_review.py\nBuild both themes: python scripts/build_theme_audio_review.py\nPrevious stellar files retained; not current approved selections.\n', encoding='utf-8')
    print('Wrote three elegant full scores and nine adaptive stems; defaults preserved.', flush=True)


if __name__ == '__main__':
    build()
