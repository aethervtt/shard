/** Scoped, host-overridable tokens. No stylesheet is installed until a view is mounted. */
export const audioEditorStyles = `
:host {
  display:block; min-width:0; min-height:0; height:100%;
  --ae-background:#171b24; --ae-surface:#222936; --ae-input:#111722;
  --ae-text:#edf2fa; --ae-muted:#b7c3d7; --ae-border:#536078;
  --ae-accent:#98c7ff; --ae-danger:#ffafb6; --ae-radius:6px;
  --ae-font:system-ui,sans-serif; --ae-space:8px; --ae-control-height:32px;
  color:var(--ae-text); font:13px/1.5 var(--ae-font); color-scheme:dark;
}
:host([data-theme="light"]) {
  --ae-background:#f5f7fb; --ae-surface:#fff; --ae-input:#fff;
  --ae-text:#202b3b; --ae-muted:#48576b; --ae-border:#8592a4;
  --ae-accent:#1555aa; --ae-danger:#ac2134; color-scheme:light;
}
* { box-sizing:border-box }
[hidden] { display:none!important }
.editor { container-type:inline-size; display:flex; flex-direction:column; height:100%; min-height:160px; min-width:0; background:var(--ae-background); overflow:hidden; border:1px solid var(--ae-border); border-radius:var(--ae-radius) }
.toolbar,.tabs,.actions { display:flex; flex-wrap:wrap; align-items:center; gap:var(--ae-space) }
.toolbar { padding:var(--ae-space); border-bottom:1px solid var(--ae-border) }
.title { font-weight:650; flex:1 1 120px; overflow-wrap:anywhere }
.tabs { padding:var(--ae-space); gap:4px; border-bottom:1px solid var(--ae-border) }
.tabs button { flex:1 1 auto }
.tabs button[aria-selected="true"] { background:var(--ae-accent); color:var(--ae-background); font-weight:650 }
.body { overflow:auto; flex:1; min-height:0; padding:var(--ae-space); scrollbar-gutter:stable }
.panel { min-width:0 }
h2,h3,p { margin:0 0 var(--ae-space) }
h2 { font-size:16px } h3 { font-size:14px }
button,input,select,textarea { font:inherit; color:inherit; max-width:100%; min-width:0 }
button,select,input,textarea { border:1px solid var(--ae-border); border-radius:4px; background:var(--ae-input); padding:5px 7px }
button,select,input:not([type="checkbox"]) { min-height:var(--ae-control-height) }
button { cursor:pointer; white-space:normal; overflow-wrap:anywhere }
button:hover:not(:disabled) { border-color:var(--ae-accent) }
button:disabled { cursor:default; opacity:.55 }
button.primary { border-color:var(--ae-accent); color:var(--ae-accent) }
:focus-visible { outline:3px solid var(--ae-accent); outline-offset:2px }
input[type="checkbox"] { width:20px; height:20px; accent-color:var(--ae-accent) }
input[type="range"] { width:100%; accent-color:var(--ae-accent) }
textarea { width:100%; min-height:100px; resize:vertical; font-family:monospace }
label,.field { display:flex; flex-direction:column; gap:4px; min-width:0 }
.field { margin:8px 0 }
.field-label { color:var(--ae-muted); overflow-wrap:anywhere }
.field input,.field select { width:100% }
.field input[type="checkbox"] { width:20px }
.field>button { align-self:flex-start; min-height:24px; font-size:11px; padding:2px 5px }
.properties { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr)); gap:0 16px; align-items:start }
.properties>details { grid-column:1/-1 }
.field-inline { display:flex; flex-wrap:wrap; align-items:center; gap:6px }
.field-inline>* { flex:1 1 80px }
.field-inline button { flex:0 1 auto }
.hint,.status { color:var(--ae-muted); font-size:12px; overflow-wrap:anywhere }
.status { padding:var(--ae-space); border-top:1px solid var(--ae-border); flex-shrink:0 }
.error { color:var(--ae-danger); white-space:pre-wrap; overflow-wrap:anywhere }
.notice { padding:var(--ae-space); border:1px solid var(--ae-border); border-radius:4px; margin-bottom:var(--ae-space) }
details { margin:8px 0; border:1px solid var(--ae-border); border-radius:4px; padding:8px; min-width:0 }
details details { border-inline-start:2px solid var(--ae-border); border-block:0; border-inline-end:0; padding:4px 0 4px 8px }
summary { cursor:pointer; overflow-wrap:anywhere; font-weight:600; min-height:24px }
.list-item { padding:8px 0; border-bottom:1px solid var(--ae-border); min-width:0 }
.list-item:last-child { border:0 }
.item-title { display:flex; flex-wrap:wrap; gap:4px; align-items:center; justify-content:space-between; margin-bottom:4px }
.item-title span { overflow-wrap:anywhere }
.item-title button { padding:2px 6px; min-height:28px }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr)); gap:var(--ae-space) }
.card { padding:var(--ae-space); border:1px solid var(--ae-border); border-radius:4px; background:var(--ae-surface); min-width:0 }
.mixer-strips { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:var(--ae-space) }
.mixer-strip { background:var(--ae-surface); border:1px solid var(--ae-border); border-radius:4px; padding:8px; min-width:0 }
.mixer-strip h3 { margin:0 0 4px; font-size:13px }
.fader-row { display:flex; align-items:center; gap:6px; min-width:0 }
.fader-row input[type="range"] { flex:1; min-width:40px }
.fader-row input[type="number"] { width:68px; flex:0 0 68px }
.meter-caption { display:block; font-size:10px; line-height:1.3 }
.event-waves { display:grid; gap:4px; margin-bottom:12px }
.wave-lane { position:relative; min-width:0; background:var(--ae-input); border:1px solid var(--ae-border); border-radius:4px }
.wave-lane canvas { height:48px; padding-inline-start:66px }
.wave-label { position:absolute; inset-inline-start:6px; top:14px; z-index:1; max-width:60px; overflow:hidden; text-overflow:ellipsis; font-size:12px }
.catalog { max-height:380px; overflow:auto; position:relative; margin-block:8px; border:1px solid var(--ae-border) }
.catalog-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-height:64px; height:64px; padding:6px; overflow:hidden; border-bottom:1px solid var(--ae-border) }
.catalog-row button { flex:1; text-align:start; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.badge { display:inline-block; border:1px solid var(--ae-border); border-radius:3px; padding:1px 5px; font-size:11px }
.timeline { overflow:auto; max-width:100%; border:1px solid var(--ae-border); border-radius:4px; margin-bottom:8px }
.timeline-lane { position:relative; min-width:440px; height:40px; background:repeating-linear-gradient(90deg,transparent,transparent 43px,var(--ae-border) 44px); border-bottom:1px solid var(--ae-border) }
.timeline-clip { position:absolute; top:5px; height:28px; min-width:16px; border:1px solid var(--ae-accent); background:var(--ae-surface); border-radius:4px; padding:2px 6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
canvas { display:block; width:100%; height:80px; background:var(--ae-input); border-radius:4px }
meter { width:100%; height:16px; accent-color:var(--ae-accent) }
pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:320px; overflow:auto; font-size:12px }
.empty { padding:16px 8px; color:var(--ae-muted) }
.sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0 }
@container (max-width:340px) {
  .toolbar { gap:4px }
  .toolbar .title { flex-basis:100% }
  .toolbar button { flex:1 1 auto }
  .tabs button { flex:1 1 28%; padding:4px }
  .field-inline { align-items:stretch }
  .body { padding:6px }
  details { padding:6px }
}
@media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto!important; animation:none!important; transition:none!important } }
@media (forced-colors:active) { button, input, select, details, .card { border:1px solid ButtonText } }
`
