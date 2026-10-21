"""Promote the approved review assets without re-encoding audio."""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
preview = ROOT / "static/v7-preview"
formal = ROOT / "static/v7"
audio = formal / "audio"
audio.mkdir(exist_ok=True)
manifest = json.loads((preview / "theme-audio/manifest.json").read_text(encoding="utf-8"))
assert manifest["version"] == "slot-review-3"
for preset in manifest["candidates"].values():
    for clip in [preset["clip"], *preset["slotClips"].values()]:
        name = Path(clip["url"]).name
        shutil.copyfile(preview / "theme-audio" / name, audio / name)
        clip["url"] = "/v7/audio/" + name
(audio / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(formal / "sound-catalog.mjs").write_text(
    "// Approved slot-review-3 assets; no re-encoding or noise layers.\n"
    + "export const SOUND_PRESETS=" + json.dumps(manifest["candidates"], ensure_ascii=False, indent=2) + ";\n"
    + "export const themeSounds=theme=>Object.entries(SOUND_PRESETS).filter(([,p])=>p.theme===(theme==='cosmic'?'cosmic':'default'));\n"
    + "export function soundFor(theme,key){return themeSounds(theme).find(([id])=>id===key)?.[0]||themeSounds(theme)[0][0];}\n",
    encoding="utf-8")
for name in ["stellar-stage.js", "stellar-profiles.mjs", "slot-audio-transport.mjs", "machine-rhythm.mjs"]:
    text = (preview / name).read_text(encoding="utf-8")
    text = text.replace("// ISOLATED DESIGN PREVIEW. Rendering fork of v6/stage.js, 2026-09-30. No business APIs.", "// Approved cosmic renderer. Business rules and entitlements remain server-owned.")
    text = text.replace("// Preview-only materials. Production profiles and purchased entitlements are unchanged.", "// Approved cosmic materials, shared by all three machines.")
    text = text.replace("// Review-only event layers.", "// Approved theme event layers.")
    if name == "slot-audio-transport.mjs":
        text = text.replace(" return {\n  start(){", " return {\n  preview(){active=true;revealed=true;voice('reveal',{ended:()=>onPhase('ended')});onPhase('preview');},\n  start(){")
    (formal / name).write_text(text, encoding="utf-8")
print("Promoted six approved sound sets and the cosmic renderer.")
