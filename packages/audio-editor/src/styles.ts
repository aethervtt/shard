/** Scoped, host-overridable tokens. No stylesheet is installed until a view is mounted. */
export const audioEditorStyles = `
:host {
  display:block; min-width:0; min-height:0; height:100%;
  --ae-background:#15191c; --ae-surface:#1d2327; --ae-input:#111619;
  --ae-text:#e5ecef; --ae-muted:#9aaab2; --ae-border:#344148;
  --ae-accent:#7ce2c3; --ae-danger:#ff9ca5; --ae-radius:10px;
  --ae-font:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --ae-space:10px; --ae-control-height:32px; --ae-on-accent:#102d25;
  --ae-hover:#293339; --ae-subtle:#232d32; --ae-track:#7ce2c3;
  color:var(--ae-text); font:12px/1.5 var(--ae-font); color-scheme:dark;
  -webkit-font-smoothing:antialiased;
}
:host([data-theme="light"]) {
  --ae-background:#f3f6f7; --ae-surface:#fff; --ae-input:#f8fafb;
  --ae-text:#203039; --ae-muted:#556b77; --ae-border:#cbd5db;
  --ae-accent:#08765c; --ae-danger:#b22e43; --ae-on-accent:#fff;
  --ae-hover:#e7edef; --ae-subtle:#e9eff1; --ae-track:#08765c; color-scheme:light;
}
* { box-sizing:border-box }
[hidden] { display:none!important }
.editor { container-type:inline-size; display:flex; flex-direction:column; height:100%; min-height:160px; min-width:0; background:var(--ae-background); overflow:hidden; border:1px solid var(--ae-border); border-radius:var(--ae-radius) }
.toolbar,.tabs,.actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--ae-space) }
.toolbar { padding:14px 16px; gap:8px; border-bottom:1px solid var(--ae-border); background:var(--ae-surface); flex-shrink:0 }
.document-identity { display:flex; align-items:center; gap:10px; flex:1 1 150px; min-width:0; margin-inline-end:8px }
.document-mark { width:32px; height:32px; display:grid; place-items:center; color:var(--ae-accent); background:color-mix(in srgb,var(--ae-accent) 10%,transparent); border:1px solid color-mix(in srgb,var(--ae-accent) 22%,transparent); border-radius:8px; flex-shrink:0 }
.document-text { min-width:0 }
.document-kind,.eyebrow { display:block; font-size:9px; font-weight:650; letter-spacing:.13em; text-transform:uppercase; color:var(--ae-muted) }
.title { display:block; font-size:13px; font-weight:650; overflow-wrap:anywhere; letter-spacing:-.01em }
.document-identity[data-dirty=true] .title::after { content:' •'; color:var(--ae-accent) }
.toolbar button { flex-shrink:0 }
.toolbar button[data-command=Undo],.toolbar button[data-command=Redo] { padding-inline:7px; background:transparent; border-color:transparent; color:var(--ae-muted) }
.toolbar button[data-command=Play] { background:var(--ae-accent); border-color:var(--ae-accent); color:var(--ae-on-accent); font-weight:700; padding-inline:14px }
.toolbar button[data-command=Play]:hover:not(:disabled) { filter:brightness(1.08) }
.toolbar button[data-command=Stop] { background:transparent }
.tabs { padding:0 12px; gap:0; border-bottom:1px solid var(--ae-border); flex-shrink:0; background:var(--ae-surface) }
.tabs button { flex:1 1 auto; border:0; border-radius:0; background:transparent; color:var(--ae-muted); padding:12px 8px; position:relative; font-weight:550; min-height:44px }
.tabs button .icon { width:15px; height:15px }
.tabs button[aria-selected=true] { color:var(--ae-accent); background:color-mix(in srgb,var(--ae-accent) 6%,transparent) }
.tabs button[aria-selected=true]::after { content:''; position:absolute; bottom:0; inset-inline:12px; height:2px; background:var(--ae-accent); border-radius:2px }
.body { overflow:auto; flex:1; min-height:0; padding:20px; scrollbar-gutter:stable; scrollbar-width:thin; scrollbar-color:var(--ae-border) transparent }
.panel { min-width:0 }
h2,h3,p { margin:0 0 var(--ae-space) }
h2 { font-size:18px; font-weight:650; letter-spacing:-.03em } h3 { font-size:13px; font-weight:650 }
button,input,select,textarea { font:inherit; color:inherit; max-width:100%; min-width:0 }
button,select,input,textarea { border:1px solid var(--ae-border); border-radius:5px; background:var(--ae-input); padding:6px 9px }
button,select,input:not([type=checkbox]) { min-height:var(--ae-control-height) }
button { display:inline-flex; align-items:center; justify-content:center; gap:7px; cursor:pointer; white-space:normal; overflow-wrap:anywhere; line-height:1.35; transition:background-color .12s,border-color .12s }
button:hover:not(:disabled) { background:var(--ae-hover); border-color:color-mix(in srgb,var(--ae-muted) 65%,var(--ae-border)) }
button:active:not(:disabled) { background:var(--ae-subtle) }
button:disabled { cursor:default; opacity:.42 }
button.primary { border-color:var(--ae-accent); color:var(--ae-accent) }
button[data-intent=danger] { color:var(--ae-muted); background:transparent; border-color:transparent }
button[data-intent=danger]:hover:not(:disabled) { color:var(--ae-danger); background:color-mix(in srgb,var(--ae-danger) 8%,transparent) }
button[data-intent=add] { color:var(--ae-accent); border-style:dashed; background:transparent; margin-top:6px }
:focus-visible { outline:2px solid var(--ae-accent); outline-offset:3px }
.icon { display:block; width:16px; height:16px; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.65; stroke-linecap:round; stroke-linejoin:round }
input[type=checkbox] { width:17px; height:17px; accent-color:var(--ae-accent) }
input[type=range] { width:100%; accent-color:var(--ae-accent); padding:0; background:transparent; border:0; cursor:pointer }
input[type=number] { font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px }
textarea { width:100%; min-height:110px; resize:vertical; font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace }
label,.field { display:flex; flex-direction:column; gap:5px; min-width:0 }
.field { margin:10px 0 }
.field .field { margin:0 }
.field-label { color:var(--ae-muted); font-size:11px; overflow-wrap:anywhere }
.field input,.field select { width:100% }
.field input[type=checkbox] { width:17px }
.field>button { align-self:flex-start; min-height:24px; font-size:10px; padding:3px 6px }
.authoring-layout { display:grid; grid-template-columns:minmax(0,1fr); gap:24px; align-items:start }
.overview,.inspector { min-width:0 }
.overview-heading { display:flex; flex-direction:column; align-items:flex-start; gap:12px; margin-bottom:22px }
.overview-heading .eyebrow { color:var(--ae-accent); margin-bottom:4px }
.overview-heading p { color:var(--ae-muted); margin:0; max-width:48ch; font-size:11px }
.overview-heading h2 { margin-bottom:5px }
.overview-count { color:var(--ae-muted); white-space:nowrap; font:10px/1.5 ui-monospace,monospace; padding-top:5px }
.inspector { padding:16px; background:var(--ae-surface); border:1px solid var(--ae-border); border-radius:8px }
.inspector-heading { padding-bottom:12px; margin-bottom:4px; border-bottom:1px solid var(--ae-border) }
.inspector-heading h3 { margin:2px 0 0; font-size:13px }
.properties { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:0 16px; align-items:start }
.properties>details { grid-column:1/-1 }
.field-inline { display:flex; flex-wrap:wrap; align-items:center; gap:6px }
.field-inline>* { flex:1 1 70px }
.field-inline button { flex:0 1 auto }
.hint,.status { color:var(--ae-muted); font-size:11px; overflow-wrap:anywhere }
.status { padding:9px 14px; border-top:1px solid var(--ae-border); flex-shrink:0; background:var(--ae-surface); font-size:10px; line-height:1.6 }
.status[data-state=playing] { border-top-color:color-mix(in srgb,var(--ae-accent) 55%,var(--ae-border)) }
.error { color:var(--ae-danger); white-space:pre-wrap; overflow-wrap:anywhere }
.notice { padding:12px; border:1px solid var(--ae-border); border-radius:6px; margin-bottom:var(--ae-space); background:var(--ae-surface) }
details { margin:14px 0; border:0; border-top:1px solid var(--ae-border); padding:12px 0 0; min-width:0 }
details details { margin:8px 0; border:0; padding:6px 0 6px 10px; border-inline-start:2px solid var(--ae-border) }
summary { cursor:pointer; overflow-wrap:anywhere; font-weight:600; min-height:26px; font-size:11px; color:var(--ae-text) }
summary::marker { color:var(--ae-muted); font-size:10px }
summary:hover { color:var(--ae-accent) }
.list-item { padding:10px 0; border-bottom:1px solid var(--ae-border); min-width:0 }
.list-item:last-child { border:0 }
.item-title { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-bottom:4px }
.item-title span { overflow-wrap:anywhere; flex:1; font-weight:600 }
.item-title button { padding:3px 5px; min-height:24px; font-size:10px }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr)); gap:var(--ae-space) }
.card { padding:14px; border:1px solid var(--ae-border); border-radius:7px; background:var(--ae-surface); min-width:0; margin-bottom:10px }
.mixer-strips { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(124px,1fr); overflow-x:auto; padding-bottom:8px; scrollbar-width:thin; scrollbar-color:var(--ae-border) transparent; gap:8px; margin-bottom:20px }
.mixer-strip { background:var(--ae-surface); border:1px solid var(--ae-border); border-top:3px solid var(--ae-track); border-radius:6px; padding:14px 10px; min-width:0; text-align:center }
.mixer-strip:nth-child(3n+2),.wave-lane:nth-child(3n+2) { --ae-track:#ab9ef0 }
.mixer-strip:nth-child(3n+3),.wave-lane:nth-child(3n+3) { --ae-track:#e8b97b }
:host([data-theme=light]) .mixer-strip:nth-child(3n+2),:host([data-theme=light]) .wave-lane:nth-child(3n+2) { --ae-track:#7059b5 }
:host([data-theme=light]) .mixer-strip:nth-child(3n+3),:host([data-theme=light]) .wave-lane:nth-child(3n+3) { --ae-track:#936424 }
.mixer-strip h3 { margin:0 0 3px; font-size:13px; overflow-wrap:anywhere }
.bus-route { color:var(--ae-muted); font-size:10px; display:block; margin-bottom:12px }
.fader-row { display:flex; flex-direction:column; align-items:center; gap:8px; min-width:0; padding-block:8px }
.fader-row input[type=range] { writing-mode:vertical-lr; direction:rtl; width:24px; height:144px; min-height:0; accent-color:var(--ae-track) }
.fader-row input[type=number] { width:70px; text-align:center }
.fader-row>.hint { margin-top:-6px; font-size:9px; text-transform:uppercase }
.meter-caption { display:block; font-size:9px; line-height:1.4; margin-top:5px; min-height:14px }
.event-waves { display:grid; gap:12px; margin-bottom:20px }
.wave-lane { position:relative; min-width:0; background:var(--ae-surface); border:1px solid var(--ae-border); border-radius:7px; overflow:hidden }
.track-header { display:flex; gap:10px; align-items:center; padding:12px; border-bottom:1px solid var(--ae-border) }
.track-number { font:10px ui-monospace,monospace; color:var(--ae-track); background:color-mix(in srgb,var(--ae-track) 10%,transparent); padding:5px 6px; border-radius:4px }
.track-name { flex:1; min-width:0; font-size:12px; font-weight:600; overflow-wrap:anywhere }
.track-name { justify-content:flex-start; padding:0; min-height:24px; background:transparent; border-color:transparent; text-align:start }
.track-header .badge { color:var(--ae-track) }
.wave-lane canvas { height:90px; border-radius:0; background:repeating-linear-gradient(90deg,transparent 0,transparent calc(25% - 1px),var(--ae-subtle) 25%),var(--ae-input) }
.track-meta { display:flex; flex-wrap:wrap; gap:6px 14px; padding:9px 12px; color:var(--ae-muted); font:10px/1.5 ui-monospace,monospace; border-top:1px solid var(--ae-border) }
.track-meta span:last-child { margin-inline-start:auto; color:var(--ae-track) }
.timing-ruler { display:flex; justify-content:space-between; color:var(--ae-muted); font:10px ui-monospace,monospace; margin-bottom:10px }
.timing-row { margin-bottom:12px }
.timing-track { position:relative; height:12px; margin-top:4px; background:var(--ae-input); border-radius:3px }
.timing-mark { position:absolute; height:100%; background:var(--ae-accent); border-radius:3px; max-width:100% }
.timing-mark[data-source-length=true] { transform:translateX(-50%); border-radius:50% }
.wave-placeholder { display:grid; place-items:center; min-height:90px; color:var(--ae-muted); font-size:11px; background:var(--ae-input) }
.catalog { max-height:440px; overflow:auto; position:relative; margin-block:16px; border:1px solid var(--ae-border); border-radius:7px; scrollbar-width:thin; scrollbar-color:var(--ae-border) transparent }
.catalog-row { display:flex; align-items:center; gap:10px; min-height:64px; height:64px; padding:8px 12px; overflow:hidden; border-bottom:1px solid var(--ae-border); background:var(--ae-surface) }
.catalog-row:last-child { border-bottom:0 }
.catalog-row:hover { background:var(--ae-hover) }
.catalog-row[data-selected=true] { background:color-mix(in srgb,var(--ae-accent) 8%,var(--ae-surface)); box-shadow:inset 3px 0 var(--ae-accent) }
.catalog-symbol { color:var(--ae-accent); background:var(--ae-subtle); padding:8px; border-radius:6px; flex-shrink:0 }
.catalog-row button { flex:1; justify-content:flex-start; text-align:start; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:transparent; border-color:transparent; padding:4px; font-weight:550 }
.badge { display:inline-block; color:var(--ae-muted); background:var(--ae-subtle); border-radius:4px; padding:3px 6px; font-size:9px; font-weight:500; white-space:nowrap }
canvas { display:block; width:100%; height:80px; background:var(--ae-input); border-radius:6px }
meter { display:block; width:100%; height:7px; accent-color:var(--ae-track); border:0; border-radius:3px; overflow:hidden; background:var(--ae-input) }
meter::-webkit-meter-bar { background:var(--ae-input); border:0; border-radius:3px; height:7px }
meter::-webkit-meter-optimum-value { background:var(--ae-track) }
meter::-moz-meter-bar { background:var(--ae-track) }
pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:320px; overflow:auto; font:10px/1.7 ui-monospace,monospace; padding:12px; background:var(--ae-input); border-radius:6px }
.empty { padding:28px 12px; color:var(--ae-muted); text-align:center }
.music-section { border-inline-start:3px solid var(--ae-accent) }
.music-section:nth-of-type(2n) { border-inline-start-color:#ab9ef0 }
.music-section h3 { font-size:14px; letter-spacing:-.02em }
.music-section .hint { padding:8px 0; margin:0; border-bottom:1px solid var(--ae-border); font-family:ui-monospace,monospace; font-size:10px }
.sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0 }
@container (min-width:760px) {
  .authoring-layout { grid-template-columns:minmax(0,1fr) 280px; gap:24px }
  .inspector { align-self:start }
  .overview { position:sticky; top:0 }
}
@container (max-width:540px) {
  .toolbar { padding:12px; gap:6px }
  .document-identity { flex-basis:100%; margin:0 0 5px }
  .toolbar button { flex:1 1 auto; padding-inline:8px }
  .toolbar button[data-command=Undo],.toolbar button[data-command=Redo],.toolbar button[data-command=Stop] { flex:0 0 auto; padding-inline:6px }
  .toolbar button[data-command=Stop] { width:32px }
  .toolbar button[data-command=Undo] .button-label,.toolbar button[data-command=Redo] .button-label,.toolbar button[data-command=Stop] .button-label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%) }
  .tabs { padding:0 6px }
  .tabs button { flex:1 1 30%; padding:9px 5px; font-size:10px; min-height:36px; gap:5px }
  .tabs button .icon { width:13px; height:13px }
  .body { padding:14px }
  .authoring-layout { gap:20px }
  .overview-heading { margin-bottom:16px }
  .overview-heading h2 { font-size:17px }
  .overview-count { display:none }
  .inspector { padding:12px }
  .mixer-strips { grid-auto-flow:row; grid-auto-columns:auto; grid-template-columns:minmax(0,1fr); gap:8px; overflow:visible }
  .mixer-strip { text-align:start; padding:12px; border-top:1px solid var(--ae-border); border-inline-start:3px solid var(--ae-track) }
  .mixer-strip h3 { font-size:12px }
  .bus-route { margin-bottom:6px }
  .fader-row { flex-direction:row; padding-block:2px; gap:8px }
  .fader-row input[type=range] { writing-mode:horizontal-tb; direction:ltr; width:100%; height:26px; flex:1; min-width:40px }
  .fader-row input[type=number] { width:58px; flex:0 0 58px }
  .fader-row>.hint { margin:0; font-size:9px }
  .meter-caption { font-size:9px }
  .catalog-row { padding-inline:8px; gap:6px }
  .catalog-symbol { padding:6px }
  .catalog-row .badge { font-size:8px; padding:3px 4px }
  .field-inline { align-items:stretch }
  .track-header { padding:10px }
  .track-meta { padding:8px 10px; gap:5px 8px; font-size:9px }
  .status { padding:8px 12px; font-size:9px }
}
@media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto!important; animation:none!important; transition:none!important } }
@media (forced-colors:active) { button,input,select,details,.card,.mixer-strip,.wave-lane { border:1px solid ButtonText } .icon { stroke:ButtonText } }
`
