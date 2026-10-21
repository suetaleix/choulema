"""Add theme-matched action notes and quiet beds for real machine-driven rhythm."""
from pathlib import Path
import json
import math
import numpy as np
import build_soft_audio_review as core
import build_theme_audio_review as defaults
import build_elegant_stellar_audio_review as elegant

OUT = elegant.OUT
SR = core.SR


def decode(path):
    raw = core.command(['-i', str(path), '-f', 'f32le', '-ar', str(SR), '-ac', '2', 'pipe:1'])
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(float)


def build():
    manifest = json.loads((OUT/'manifest.json').read_text('utf-8'))
    samples, _ = defaults.instruments()
    roots = {'cosmic4':65, 'cosmic5':63, 'cosmic6':61}
    for key, entry in manifest['candidates'].items():
        cosmic = entry['theme']=='cosmic'
        if cosmic:
            f = elegant.hz(roots[key])
            pulse = elegant.pluck(f, .30 if key=='cosmic6' else .25,
                'harp' if key=='cosmic5' else 'felt')
            pulse = core.lowpass(pulse, 2200 if key=='cosmic6' else 2900)
        else:
            p = defaults.PRESETS[key]
            pulse = defaults.sampled_note(samples[p['instrument']], p['root'], .18, .014)
            full = decode(OUT/Path(entry['clip']['url']).name)
            motion = np.zeros((int(12.8*SR), 2))
            # Keep the original startup, then let physical actions provide rhythm.
            intro = core.fades(full[:int(.83*SR)], .004, .12)
            motion[:len(intro)] += intro
            midi = 69+12*math.log2(p['root']/440)
            bed = elegant.veil([midi-12,midi-5], 11.5, 1.5, 2.0)*.007
            motion[int(.5*SR):int(.5*SR)+len(bed)] += bed
            coast = np.zeros((int(4.5*SR), 2))
            coast_bed = elegant.veil([midi-5,midi], 3.9, .8, 1.5)*.009
            coast[:len(coast_bed)] = coast_bed
            reveal = core.fades(full[int(11.8*SR):int(16*SR)], .012, .20)
            entry['adaptiveClips']={name:elegant.encode(key+'-motion-v2-'+name, sound, 0)
                for name,sound in {'motion':motion,'coast':coast,'reveal':reveal}.items()}
            entry['playback']=dict(crossfadeSeconds=.20,fadeInSeconds=.045,sustainLoop=False)
        # Fixed peak for small action notes; stage energy controls their dynamics.
        peak=max(float(np.max(np.abs(pulse))),1e-6)
        target=-17.5 if cosmic else -15.0
        clip=elegant.encode(key+'-action-v2',pulse,target-20*math.log10(peak))
        entry['rhythmClip']=clip
        entry['rhythmRevision']='machine-motion-2'
        entry['playback']['bedLevel']=.42 if cosmic else .40
        entry['playback']['rhythmLevel']=.88 if cosmic else 1.0
        print(key, 'action',clip['duration'],clip['truePeakDbTP'],flush=True)
    manifest['motionRevision']='machine-motion-2'
    (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    credits=OUT/'CREDITS.txt'
    text=credits.read_text('utf-8')
    marker='Machine rhythm revision 2:'
    text=text.split(marker)[0].rstrip()+'\n'
    credits.write_text(text+marker+' default pulse uses the same credited Kenney single-note samples; stellar pulses use the original elegant synthesis.\nRuntime notes are driven by wheel sector crossings, sphere angular travel and measured capsule collision impulses, not a fixed metronome.\nDefault full audio reels remain timbre references; complete 3D preview is the rhythm acceptance surface.\nBuild adaptive action assets: python scripts/build_machine_rhythm_review.py\n',encoding='utf-8')


if __name__=='__main__':
    build()
