#!/usr/bin/env python3
"""Copy film data to standalone projects, retaining the original trees."""
from pathlib import Path
import shutil, json
ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ROOT.parent

def copy(src, dst):
    if src.is_dir(): shutil.copytree(src, dst, dirs_exist_ok=True)
    elif src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')

astra = PROJECTS / 'claude-work/astra'
bread = PROJECTS / 'breadway-films'
for f in (astra/'engine').glob('*.js'): copy(f, ROOT/'compat/astra'/f.name)
for f in (bread/'src').glob('*.js'): copy(f, ROOT/'compat/breadway'/f.name)
stage=ROOT/'compat/astra/stage.js'
text=stage.read_text().replace("this.railName.textContent = ch ? `${String(ch).padStart(2, '0')} · ${this.opts.chapters[ch - 1]}` : '';","const label = ch ? `${String(ch).padStart(2, '0')} · ${this.opts.chapters[ch - 1]}` : '';\n      if (this.railName.textContent !== label) this.railName.textContent = label;")
stage.write_text(text)
for name in ('music_stream.py','score_synth.py','music.py','narration_alignment.py','mix.py'):
    copy(astra/name, ROOT/'compat/astra'/name)
# Timing and scene code belong to film projects, not the engine.
dest = PROJECTS/'astra-films'
for name in ('scenes','scenes_edu','assets','style.css','index.html','preview.js','main.js','out'):
    copy(astra/name, dest/name)
for f in dest.rglob('*.js'):
    f.write_text(f.read_text().replace("'../engine/", "'/engine/compat/astra/").replace("'./engine/", "'/engine/compat/astra/"))
# Reuse the matching original recordings if the full local working copy is present.
full=PROJECTS/'astra-video'
if (full/'out/tts').exists() and (full/'scenes/index.js').read_bytes()==(astra/'scenes/index.js').read_bytes():
    for name in ('tts','narration.json','final_audio.m4a','edu/tts','edu/narration.json','edu/alignment_report.json','edu/final_audio.m4a','edu/preview_audio.m4a','edu/preview_audio_original.m4a','edu/original/final_audio.m4a','edu/original/preview_audio.m4a','edu/original/timeline.json'):
        copy(full/'out'/name,dest/'out'/name)
main=dest/'main.js';main.write_text(main.read_text().replace('window.__seek = (T) => stage.seek(T);','window.__seek = (T, frame) => stage.seek(T, frame);'))
for name in ('astra','edu'):
    write(dest/f'{name}.film.json', {'schemaVersion':1,'id':name,'apiVersion':'0.1.0','renderer':'browser-only','adapter':'astra','entry':'index.html','query':{'film':name,'render':'1'},'design':{'width':1920,'height':1080},'dependencies':['scenes','scenes_edu','assets','style.css','main.js'], 'audio':{'provider':'astra-score','film':name,'file':'out/edu/final_audio.m4a' if name=='edu' else 'out/final_audio.m4a'},'narration':{'file': 'out/edu/narration.json' if name=='edu' else 'out/narration.json'}})
dest=PROJECTS/'breadway-film-projects'
for name in ('films','assets','fonts','data.js','index.html','player.html','out'):
    copy(bread/name, dest/name)
for name in ('index.html','player.html'):
    f=dest/name; f.write_text(f.read_text().replace('src="src/','src="/engine/compat/breadway/'))
for data in sorted((dest/'films').glob('*.data.js')):
    name=data.name.removesuffix('.data.js')
    if not (dest/'films'/f'{name}.draw.js').exists(): continue
    vertical='vertical' in name
    write(dest/f'{name}.film.json', {'schemaVersion':1,'apiVersion':'0.1.0','id':name,'renderer':'browser-only','adapter':'breadway','entry':'index.html','query':{'film':name,'w':1080 if vertical else 1920,'h':1920 if vertical else 1080},'design':{'width':1080 if vertical else 1920,'height':1920 if vertical else 1080},'dependencies':['films','assets','fonts','data.js'],'audio':{'provider':'breadway-score'},'privacy':'private' if name=='private' else 'unspecified'})
for d in (PROJECTS/'astra-films',dest):
    (d/'README.md').write_text('# Standalone film project\n\nFilm scripts and assets live here. Reusable code is provided by `../lucent`.\n\nRun `node ../lucent/cli.mjs inspect <name>.film.json`, or replace `inspect` with `preview`, `stills`, `render`, or `audio`. Originals have been retained.\n')
print('Migrated both collections; original projects retained.')
