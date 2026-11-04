(() => {
'use strict';
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const api = window.api || {};
const viewer = $('#viewer'), pagesEl = $('#pages'), thumbsEl = $('#thumbs');
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const round1 = (n) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ state */
const S = {
  bytes: null, doc: null, pages: [], annots: [], imgs: {},
  zoom: 1.2, tool: 'select', selected: null,
  fileName: 'untitled.pdf', origPath: null, savePath: null, dirty: false,
  undo: [], redo: [], selPages: new Set(), lastSel: null, curPage: 0, gen: 0,
  fonts: [], pending: null, drag: null, lines: {}, hits: [], hitIdx: -1, dragThumb: false,
  style: { font: 'Helvetica', size: 14, bold: false, italic: false, color: '#000000',
           stroke: '#e11d48', width: 2, fillOn: false, fill: '#fde047', hl: '#facc15' },
};
let nextId = 1, nextImg = 1, pageObserver = null, thumbObserver = null;

/* ---------------------------------------------------------------- helpers */
let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = isErr ? 'error' : ''; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 2600);
}
function setDirty(d) {
  S.dirty = d;
  if (api.setDirty) api.setDirty(d, S.doc ? S.fileName : '');
}
const hexOf = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const dataBytes = (u) => { const b = atob(u.split(',')[1]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
const getAnnot = (id) => S.annots.find((a) => a.id === id);
const getSel = () => (S.selected != null ? getAnnot(S.selected) : null);
const elOf = (id) => pagesEl.querySelector(`.ann[data-id="${id}"]`);
const cssFont = (n) => ({ Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' }[n] || `"${n}", sans-serif`);
const STD = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

/* ---------------------------------------------------------------- history */
const snap = () => ({ bytes: S.bytes, annots: JSON.stringify(S.annots) });
function pushUndo(s) {
  S.undo.push(s || snap());
  if (S.undo.length > 100) S.undo.shift();
  S.redo.length = 0;
  setDirty(true); updateUI();
}
let lastKey = '', lastT = 0;
function pushUndoCoalesced(key) {
  const now = Date.now();
  if (key === lastKey && now - lastT < 1200) { lastT = now; return; }
  lastKey = key; lastT = now; pushUndo();
}
async function restore(s) {
  const changed = s.bytes !== S.bytes;
  S.annots = JSON.parse(s.annots); S.selected = null;
  if (changed) { await loadBytes(s.bytes, true); } else { renderAllAnnots(); }
  setDirty(true); updateUI();
}
async function undo() { if (!S.undo.length || !S.doc) return; S.redo.push(snap()); await restore(S.undo.pop()); }
async function redo() { if (!S.redo.length || !S.doc) return; S.undo.push(snap()); await restore(S.redo.pop()); }

/* ------------------------------------------------------- load & render PDF */
async function loadBytes(bytes, keepScroll) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  let doc;
  try { doc = await task.promise; }
  catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected and can’t be opened yet.');
    throw e;
  }
  const metas = await Promise.all(Array.from({ length: doc.numPages }, async (_, i) => {
    const pg = await doc.getPage(i + 1);
    return { i, vp: pg.getViewport({ scale: 1 }), rot: ((pg.rotate % 360) + 360) % 360 };
  }));
  if (S.doc) { try { S.doc.destroy(); } catch {} }
  S.bytes = bytes; S.doc = doc; S.pages = metas; S.lines = {};
  S.selPages = new Set([...S.selPages].filter((i) => i < metas.length));
  const y = keepScroll ? viewer.scrollTop : 0;
  buildPages(); buildThumbs();
  viewer.scrollTop = y;
  updateUI();
}

function buildPages() {
  S.gen++;
  if (pageObserver) pageObserver.disconnect();
  pagesEl.innerHTML = '';
  pageObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const p = S.pages[+en.target.dataset.i]; if (!p) continue;
      if (en.isIntersecting) renderPage(p); else releasePage(p);
    }
  }, { root: viewer, rootMargin: '900px 0px' });
  for (const p of S.pages) {
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.i = p.i;
    el.style.width = p.vp.width * S.zoom + 'px'; el.style.height = p.vp.height * S.zoom + 'px';
    const canvas = document.createElement('canvas');
    const hits = document.createElement('div'); hits.className = 'overlay hits';
    const layer = document.createElement('div'); layer.className = 'overlay layer';
    for (const o of [hits, layer]) {
      o.style.width = p.vp.width + 'px'; o.style.height = p.vp.height + 'px'; o.style.transform = `scale(${S.zoom})`;
    }
    el.append(canvas, hits, layer);
    Object.assign(p, { el, canvas, hits, layer, rendered: false, rendering: false, task: null });
    layer.addEventListener('pointerdown', (ev) => onLayerDown(ev, p.i));
    layer.addEventListener('dblclick', (ev) => onLayerDbl(ev, p.i));
    pagesEl.appendChild(el);
    pageObserver.observe(el);
  }
  renderAllAnnots(); renderHits();
}

async function renderPage(p) {
  if (p.rendered || p.rendering) return;
  p.rendering = true; const gen = S.gen;
  try {
    const page = await S.doc.getPage(p.i + 1);
    if (gen !== S.gen) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: S.zoom * dpr });
    const c = p.canvas;
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = p.vp.width * S.zoom + 'px'; c.style.height = p.vp.height * S.zoom + 'px';
    p.task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    await p.task.promise;
    p.rendered = true; p.pxScale = c.width / p.vp.width;
  } catch (e) {
    if (!e || e.name !== 'RenderingCancelledException') console.error(e);
  } finally { p.rendering = false; p.task = null; }
}
function releasePage(p) {
  if (p.task) { try { p.task.cancel(); } catch {} }
  if (p.rendered) { p.canvas.width = 0; p.canvas.height = 0; p.rendered = false; }
}

/* -------------------------------------------------------------- thumbnails */
function buildThumbs() {
  thumbsEl.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((es) => es.forEach((en) => {
    if (en.isIntersecting) { renderThumb(+en.target.dataset.i); thumbObserver.unobserve(en.target); }
  }), { root: thumbsEl, rootMargin: '500px 0px' });
  for (const p of S.pages) {
    const i = p.i, W = 124;
    const t = document.createElement('div'); t.className = 'thumb'; t.dataset.i = i; t.draggable = true;
    const c = document.createElement('canvas');
    c.style.width = W + 'px'; c.style.height = Math.round(W * p.vp.height / p.vp.width) + 'px';
    c.width = 1; c.height = 1;
    const l = document.createElement('div'); l.className = 'lbl'; l.textContent = i + 1;
    t.append(c, l);
    t.addEventListener('click', (e) => {
      if (e.shiftKey && S.lastSel != null) {
        const [a, b] = [Math.min(S.lastSel, i), Math.max(S.lastSel, i)];
        S.selPages = new Set(); for (let k = a; k <= b; k++) S.selPages.add(k);
      } else if (e.ctrlKey || e.metaKey) {
        S.selPages.has(i) ? S.selPages.delete(i) : S.selPages.add(i); S.lastSel = i;
      } else { S.selPages = new Set([i]); S.lastSel = i; }
      refreshThumbSel(); scrollToPage(i);
    });
    t.addEventListener('dragstart', (e) => {
      if (!S.selPages.has(i)) { S.selPages = new Set([i]); refreshThumbSel(); }
      e.dataTransfer.setData('text/plain', 'pdfstudio-pages'); e.dataTransfer.effectAllowed = 'move'; S.dragThumb = true;
    });
    t.addEventListener('dragover', (e) => {
      if (!S.dragThumb) return; e.preventDefault();
      const r = t.getBoundingClientRect(); t._after = e.clientY > r.top + r.height / 2;
      clearDropMarks(); t.classList.add(t._after ? 'dropafter' : 'dropbefore');
    });
    t.addEventListener('dragleave', () => t.classList.remove('dropafter', 'dropbefore'));
    t.addEventListener('drop', (e) => {
      if (!S.dragThumb) return; e.preventDefault(); e.stopPropagation();
      const pos = i + (t._after ? 1 : 0); clearDropMarks(); S.dragThumb = false; movePagesTo(pos);
    });
    t.addEventListener('dragend', () => { S.dragThumb = false; clearDropMarks(); });
    thumbsEl.appendChild(t); thumbObserver.observe(t);
  }
  refreshThumbSel();
}
const clearDropMarks = () => $$('.thumb.dropafter,.thumb.dropbefore').forEach((t) => t.classList.remove('dropafter', 'dropbefore'));
async function renderThumb(i) {
  const gen = S.gen; const t = thumbsEl.children[i]; if (!t) return;
  try {
    const page = await S.doc.getPage(i + 1);
    if (gen !== S.gen) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (124 * dpr) / S.pages[i].vp.width });
    const c = t.querySelector('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  } catch {}
}
function refreshThumbSel() {
  $$('.thumb', thumbsEl).forEach((t) => {
    const i = +t.dataset.i;
    t.classList.toggle('sel', S.selPages.has(i)); t.classList.toggle('cur', i === S.curPage);
  });
}
function scrollToPage(i) {
  const p = S.pages[i]; if (!p) return;
  viewer.scrollTop = p.el.offsetTop - 14;
}
let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurPage(); });
});
function updateCurPage() {
  if (!S.pages.length) return;
  const vr = viewer.getBoundingClientRect(); const mid = vr.top + vr.height * 0.35;
  let best = 0, bd = Infinity;
  for (const p of S.pages) {
    const r = p.el.getBoundingClientRect();
    const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
    if (d < bd) { bd = d; best = p.i; }
    if (d === 0) break;
  }
  if (best !== S.curPage) {
    S.curPage = best; $('#pageInput').value = best + 1; refreshThumbSel();
    const t = thumbsEl.children[best]; if (t) t.scrollIntoView({ block: 'nearest' });
  }
}

/* ------------------------------------------------------------- annotations */
const resizable = (a) => ['rect', 'ellipse', 'highlight', 'image'].includes(a.type);
function bbox(a) {
  if (a.type === 'line' || a.type === 'arrow') return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  if (a.type === 'pen') {
    const xs = a.pts.map((p) => p[0]), ys = a.pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 };
}
const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

function mountAnnot(a) {
  const p = S.pages[a.page]; if (!p) return null;
  const old = elOf(a.id); if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'ann ' + a.type + (S.selected === a.id ? ' sel' : '');
  el.dataset.id = a.id;
  const b = bbox(a);
  el.style.left = b.x + 'px'; el.style.top = b.y + 'px';
  if (a.type !== 'text') { el.style.width = Math.max(b.w, 1) + 'px'; el.style.height = Math.max(b.h, 1) + 'px'; }
  const svg = () => { const s = mk('svg', { width: Math.max(b.w, 1), height: Math.max(b.h, 1) }); el.appendChild(s); return s; };
  const addHit = (s, node, sw) => { const h = node.cloneNode(); h.setAttribute('class', 'hitline'); h.setAttribute('stroke-width', Math.max(sw || 0, 12)); s.appendChild(h); };
  switch (a.type) {
    case 'text': {
      el.style.fontSize = a.size + 'px'; el.style.fontFamily = cssFont(a.font); el.style.color = a.color;
      el.style.fontWeight = a.bold ? '700' : '400'; el.style.fontStyle = a.italic ? 'italic' : 'normal';
      const t = document.createElement('div'); t.className = 'txt'; t.textContent = a.text; el.appendChild(t);
      break;
    }
    case 'highlight': el.style.background = a.color; break;
    case 'image': { const im = new Image(); im.src = S.imgs[a.img].dataUrl; el.appendChild(im); break; }
    case 'rect': {
      const s = svg();
      s.appendChild(mk('rect', { x: 0, y: 0, width: b.w, height: b.h, fill: a.fill || 'none', stroke: a.stroke || 'none', 'stroke-width': a.sw || 0 }));
      if (a.stroke && !a.fill) addHit(s, mk('rect', { x: 0, y: 0, width: b.w, height: b.h }), a.sw);
      break;
    }
    case 'ellipse': {
      const s = svg(); const at = { cx: b.w / 2, cy: b.h / 2, rx: b.w / 2, ry: b.h / 2 };
      s.appendChild(mk('ellipse', { ...at, fill: a.fill || 'none', stroke: a.stroke || 'none', 'stroke-width': a.sw || 0 }));
      if (a.stroke && !a.fill) addHit(s, mk('ellipse', at), a.sw);
      break;
    }
    case 'line': case 'arrow': {
      const s = svg(); const x1 = a.x1 - b.x, y1 = a.y1 - b.y, x2 = a.x2 - b.x, y2 = a.y2 - b.y;
      const ln = mk('line', { x1, y1, x2, y2, stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': 'round' });
      s.appendChild(ln); addHit(s, mk('line', { x1, y1, x2, y2 }), a.sw);
      if (a.type === 'arrow') {
        const h = arrowHead(a); const d = `M ${h[0][0] - b.x} ${h[0][1] - b.y} L ${x2} ${y2} L ${h[1][0] - b.x} ${h[1][1] - b.y}`;
        s.appendChild(mk('path', { d, fill: 'none', stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      }
      break;
    }
    case 'pen': {
      const s = svg(); const pts = a.pts.map((q) => `${q[0] - b.x},${q[1] - b.y}`).join(' ');
      s.appendChild(mk('polyline', { points: pts, fill: 'none', stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      addHit(s, mk('polyline', { points: pts, fill: 'none' }), a.sw);
      break;
    }
  }
  if (S.selected === a.id && resizable(a)) { const h = document.createElement('div'); h.className = 'handle'; el.appendChild(h); }
  p.layer.appendChild(el);
  if (a.type === 'text') { a.w = el.offsetWidth; a.h = el.offsetHeight; }
  return el;
}
function arrowHead(a) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), L = Math.max(10, a.sw * 4.5);
  return [-1, 1].map((s) => [a.x2 - L * Math.cos(ang + s * 0.45), a.y2 - L * Math.sin(ang + s * 0.45)]);
}
function renderAllAnnots() {
  S.pages.forEach((p) => { p.layer && (p.layer.innerHTML = ''); });
  S.annots.forEach(mountAnnot);
}
function select(id) {
  const prev = S.selected; S.selected = id;
  if (prev != null && prev !== id) { const a = getAnnot(prev); if (a) mountAnnot(a); }
  if (id != null) { const a = getAnnot(id); if (a) mountAnnot(a); }
  updateProps();
}
function removeAnnot(a) {
  S.annots = S.annots.filter((x) => x !== a);
  const e = elOf(a.id); if (e) e.remove();
  if (S.selected === a.id) S.selected = null;
}
function deleteSelected() {
  const a = getSel(); if (!a) return;
  pushUndo(); removeAnnot(a); updateProps();
}
function duplicateSelected() {
  const a = getSel(); if (!a) return;
  pushUndo();
  const c = JSON.parse(JSON.stringify(a)); c.id = nextId++;
  const mv = (o) => { for (const k of ['x', 'x1', 'x2']) if (k in o) o[k] += 14; for (const k of ['y', 'y1', 'y2']) if (k in o) o[k] += 14; };
  mv(c); if (c.pts) c.pts = c.pts.map((q) => [q[0] + 14, q[1] + 14]);
  S.annots.push(c); mountAnnot(c); select(c.id);
}

/* ----------------------------------------------------------- pointer input */
function toModel(ev, p) {
  const r = p.layer.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / S.zoom, y: (ev.clientY - r.top) / S.zoom };
}
const clampPt = (q, p) => ({ x: clamp(q.x, 0, p.vp.width), y: clamp(q.y, 0, p.vp.height) });

window.addEventListener('pointermove', (e) => S.drag && S.drag.move(e));
window.addEventListener('pointerup', (e) => { const d = S.drag; S.drag = null; if (d && d.up) d.up(e); });

function onLayerDown(ev, i) {
  if (ev.button !== 0 || !S.doc) return;
  const p = S.pages[i], pt = toModel(ev, p), tool = S.tool, target = ev.target;
  if (target.closest && target.closest('.ann.editing')) return; // let the caret work
  const ae = document.activeElement;
  if (ae && ae.isContentEditable) ae.blur();
  if (tool === 'select' || tool === 'text') {
    const annEl = target.closest('.ann');
    if (annEl) {
      const a = getAnnot(+annEl.dataset.id); if (!a) return;
      ev.preventDefault();
      select(a.id);
      if (target.classList.contains('handle')) startResize(ev, a, p); else startMove(ev, a, p);
      return;
    }
    ev.preventDefault();
    if (tool === 'select') { select(null); return; }
    createText(i, pt); return;
  }
  ev.preventDefault();
  if (tool === 'edit') return void editExisting(i, pt);
  if (tool === 'signature' || tool === 'image') return placePending(i, pt);
  startShape(ev, i, pt);
}
function onLayerDbl(ev) {
  const annEl = ev.target.closest && ev.target.closest('.ann.text');
  if (!annEl) return;
  const a = getAnnot(+annEl.dataset.id); if (a) beginEdit(a, snap(), false);
}

function startMove(ev, a, p) {
  const start = toModel(ev, p), before = snap(), orig = JSON.parse(JSON.stringify(a)); let moved = false;
  S.drag = {
    move: (e) => {
      const q = toModel(e, p), dx = q.x - start.x, dy = q.y - start.y;
      if (!moved && Math.hypot(dx, dy) * S.zoom < 3) return;
      moved = true;
      for (const k of ['x', 'x1', 'x2']) if (k in orig) a[k] = orig[k] + dx;
      for (const k of ['y', 'y1', 'y2']) if (k in orig) a[k] = orig[k] + dy;
      if (orig.pts) a.pts = orig.pts.map((r) => [r[0] + dx, r[1] + dy]);
      mountAnnot(a);
    },
    up: () => {
      if (moved) pushUndo(before);
      else if (S.tool === 'text' && a.type === 'text') beginEdit(a, before, false);
    },
  };
}
function startResize(ev, a, p) {
  const start = toModel(ev, p), before = snap(), o = { w: a.w, h: a.h }; let moved = false;
  S.drag = {
    move: (e) => {
      const q = toModel(e, p), dx = q.x - start.x, dy = q.y - start.y; moved = true;
      if (a.type === 'image') { a.w = Math.max(10, o.w + dx); a.h = a.w * o.h / o.w; }
      else { a.w = Math.max(6, o.w + dx); a.h = Math.max(6, o.h + dy); }
      mountAnnot(a);
    },
    up: () => { if (moved) pushUndo(before); },
  };
}
function startShape(ev, i, pt) {
  const p = S.pages[i], t = S.tool, st = S.style, before = snap(), s0 = clampPt(pt, p);
  let a;
  switch (t) {
    case 'highlight': a = { type: 'highlight', x: s0.x, y: s0.y, w: 0, h: 0, color: st.hl }; break;
    case 'whiteout': a = { type: 'rect', kind: 'cover', x: s0.x, y: s0.y, w: 0, h: 0, fill: '#ffffff', stroke: null, sw: 0 }; break;
    case 'rect': case 'ellipse':
      a = { type: t, x: s0.x, y: s0.y, w: 0, h: 0, stroke: st.stroke, sw: st.width, fill: st.fillOn ? st.fill : null }; break;
    case 'line': case 'arrow': a = { type: t, x1: s0.x, y1: s0.y, x2: s0.x, y2: s0.y, stroke: st.stroke, sw: st.width }; break;
    case 'pen': a = { type: 'pen', pts: [[s0.x, s0.y]], stroke: st.stroke, sw: st.width }; break;
    default: return;
  }
  a.id = nextId++; a.page = i; S.annots.push(a);
  S.drag = {
    move: (e) => {
      const q = clampPt(toModel(e, p), p);
      if (a.type === 'line' || a.type === 'arrow') {
        a.x2 = q.x; a.y2 = q.y;
        if (e.shiftKey) { const dx = q.x - a.x1, dy = q.y - a.y1; if (Math.abs(dx) > Math.abs(dy) * 2) a.y2 = a.y1; else if (Math.abs(dy) > Math.abs(dx) * 2) a.x2 = a.x1; }
      } else if (a.type === 'pen') {
        const l = a.pts[a.pts.length - 1]; if (Math.hypot(q.x - l[0], q.y - l[1]) > 1.2) a.pts.push([q.x, q.y]);
      } else {
        a.x = Math.min(s0.x, q.x); a.y = Math.min(s0.y, q.y); a.w = Math.abs(q.x - s0.x); a.h = Math.abs(q.y - s0.y);
      }
      mountAnnot(a);
    },
    up: () => {
      const b = bbox(a);
      const ok = a.type === 'pen' ? a.pts.length >= 2 : (a.type === 'line' || a.type === 'arrow') ? Math.hypot(b.w, b.h) >= 3 : b.w >= 3 && b.h >= 3;
      if (!ok) { removeAnnot(a); return; }
      pushUndo(before);
    },
  };
}

/* ------------------------------------------------------------ text editing */
function createText(i, pt) {
  const st = S.style, before = snap();
  const a = { id: nextId++, type: 'text', page: i, x: pt.x, y: pt.y - st.size * 0.6, text: '', size: st.size, color: st.color, font: st.font, bold: st.bold, italic: st.italic };
  S.annots.push(a); S.selected = a.id; mountAnnot(a); updateProps();
  beginEdit(a, before, true);
}
function beginEdit(a, before, isNew) {
  const el = elOf(a.id); if (!el) return;
  S.selected = a.id; el.classList.add('sel');
  const t = el.querySelector('.txt'); const old = a.text;
  el.classList.add('editing'); t.contentEditable = 'plaintext-only'; t.focus();
  const sel = getSelection(), r = document.createRange(); r.selectNodeContents(t); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  const done = () => {
    t.removeEventListener('blur', done);
    const txt = t.innerText.replace(/​/g, '').replace(/\n+$/, '');
    t.contentEditable = 'false'; el.classList.remove('editing');
    if (!txt.trim()) {
      removeAnnot(a); if (!isNew) pushUndo(before); updateProps(); return;
    }
    if (txt !== old) { a.text = txt; pushUndo(before); }
    mountAnnot(a); updateProps();
  };
  t.addEventListener('blur', done);
  t.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); t.blur(); } e.stopPropagation(); });
  updateProps();
}

async function getLines(i) {
  if (S.lines[i]) return S.lines[i];
  const page = await S.doc.getPage(i + 1), tc = await page.getTextContent(), vp = S.pages[i].vp;
  const runs = [], rotated = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (!size) continue;
    if (tx[0] <= 0 || Math.abs(tx[1]) > 0.05 * size) { // rotated text: searchable, not editable
      const len = Math.hypot(tx[0], tx[1]) || 1, ux = tx[0] / len, uy = tx[1] / len, w = it.width;
      const c = [[0, 0.95, 0], [0, -0.25, 0], [0, 0.95, 1], [0, -0.25, 1]].map(([, k, m]) => [tx[4] + tx[2] * k + ux * w * m, tx[5] + tx[3] * k + uy * w * m]);
      const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]);
      rotated.push({ str: it.str, x: Math.min(...xs), w: Math.max(...xs) - Math.min(...xs), top: Math.min(...ys), bottom: Math.max(...ys), size, rotated: true });
      continue;
    }
    const fam = ((tc.styles[it.fontName] || {}).fontFamily || '').toLowerCase();
    runs.push({ str: it.str, x: tx[4], baseline: tx[5], size, w: it.width, font: fam.includes('mono') ? 'Courier' : fam.includes('serif') && !fam.includes('sans') ? 'Times' : 'Helvetica' });
  }
  const lines = []; let cur = null;
  for (const r of runs) {
    const gap = cur ? r.x - (cur.x + cur.w) : 0;
    if (cur && Math.abs(r.baseline - cur.baseline) < cur.size * 0.25 && gap > -cur.size * 0.3 && gap < cur.size * 1.2 && Math.abs(r.size - cur.size) < cur.size * 0.25) {
      if (gap > cur.size * 0.2 && !cur.str.endsWith(' ') && !r.str.startsWith(' ')) cur.str += ' ';
      cur.str += r.str; cur.w = r.x + r.w - cur.x;
    } else { if (cur) lines.push(cur); cur = { ...r }; }
  }
  if (cur) lines.push(cur);
  const out = lines.map((l) => ({ ...l, str: l.str.replace(/\s+$/, ''), top: l.baseline - l.size * 0.95, bottom: l.baseline + l.size * 0.25 })).filter((l) => l.str.trim());
  return (S.lines[i] = out.concat(rotated.filter((r) => r.str.trim())));
}
function sampleColors(p, L) {
  const dflt = { bg: '#ffffff', fg: '#000000' };
  if (!p.rendered || !p.canvas.width) return dflt;
  const k = p.pxScale, c = p.canvas, ctx = c.getContext('2d');
  const x0 = Math.max(0, Math.floor((L.x - 2) * k)), y0 = Math.max(0, Math.floor(L.top * k));
  const x1 = Math.min(c.width, Math.ceil((L.x + L.w + 2) * k)), y1 = Math.min(c.height, Math.ceil(L.bottom * k));
  const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) return dflt;
  const d = ctx.getImageData(x0, y0, w, h).data, counts = new Map();
  const add = (px, py) => {
    const o = (py * w + px) * 4, key = ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3), e = counts.get(key);
    if (e) e.n++; else counts.set(key, { n: 1, r: d[o], g: d[o + 1], b: d[o + 2] });
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  let bg = null; for (const v of counts.values()) if (!bg || v.n > bg.n) bg = v;
  let best = 0, fg = { r: 0, g: 0, b: 0 };
  for (let o = 0; o < d.length; o += 4) {
    const dist = (d[o] - bg.r) ** 2 + (d[o + 1] - bg.g) ** 2 + (d[o + 2] - bg.b) ** 2;
    if (dist > best) { best = dist; fg = { r: d[o], g: d[o + 1], b: d[o + 2] }; }
  }
  if (best < 900) fg = { r: 0, g: 0, b: 0 };
  return { bg: hexOf(bg.r, bg.g, bg.b), fg: hexOf(fg.r, fg.g, fg.b) };
}
async function editExisting(i, pt) {
  const lines = await getLines(i);
  const L = lines.find((l) => !l.rotated && pt.x >= l.x - 2 && pt.x <= l.x + l.w + 2 && pt.y >= l.top && pt.y <= l.bottom);
  if (!L) { toast('No editable text there — click directly on a line of text.'); return; }
  const before = snap(), { bg, fg } = sampleColors(S.pages[i], L);
  const cover = { id: nextId++, type: 'rect', kind: 'cover', page: i, x: L.x - 1.5, y: L.top - 1, w: L.w + 3, h: L.bottom - L.top + 2, fill: bg, stroke: null, sw: 0 };
  const a = { id: nextId++, type: 'text', page: i, x: L.x, y: L.baseline - L.size * 0.94, text: L.str, size: round1(L.size), color: fg, font: L.font, bold: false, italic: false };
  S.annots.push(cover, a); mountAnnot(cover); S.selected = a.id; mountAnnot(a);
  pushUndo(before);
  S.style.size = a.size; S.style.font = a.font; S.style.color = a.color;
  beginEdit(a, snap(), false);
}

/* ------------------------------------------------- images & signature flow */
async function fileToImage(file, maxDim = 2400) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not read that image.')); im.src = url; });
    const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d');
    const jpeg = file.type === 'image/jpeg';
    if (jpeg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { canvas: c, dataUrl: c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92), w: c.width, h: c.height, mime: jpeg ? 'image/jpeg' : 'image/png' };
  } finally { URL.revokeObjectURL(url); }
}
function storeImage(info) { const key = 'img' + nextImg++; S.imgs[key] = { dataUrl: info.dataUrl, w: info.w, h: info.h, mime: info.mime || 'image/png' }; return key; }
function setPending(info, kind, widthPt) {
  const key = storeImage(info), w = widthPt, h = widthPt * info.h / info.w;
  S.pending = { key, w, h, kind };
  toast(kind === 'signature' ? 'Click on the page where the signature should go.' : 'Click on the page where the image should go.');
  setTool(kind === 'signature' ? 'signature' : 'image');
}
function placePending(i, pt) {
  const pd = S.pending;
  if (!pd) { S.tool === 'image' ? $('#imageFile').click() : openSignature(); return; }
  const p = S.pages[i], before = snap();
  let w = pd.w, h = pd.h; const maxW = p.vp.width * 0.85; if (w > maxW) { h = h * maxW / w; w = maxW; }
  const a = { id: nextId++, type: 'image', kind: pd.kind, page: i, x: clamp(pt.x - w / 2, 0, p.vp.width - w), y: clamp(pt.y - h / 2, 0, Math.max(0, p.vp.height - h)), w, h, img: pd.key };
  S.annots.push(a); pushUndo(before); S.pending = null; setTool('select'); select(a.id);
}
$('#imageFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) { setTool('select'); return; }
  try { const info = await fileToImage(f); setPending(info, 'image', Math.min(info.w, 260)); }
  catch (err) { toast(err.message, true); setTool('select'); }
});

/* ---- signature dialog ---- */
const sigModal = $('#sigModal'), sigCanvas = $('#sigCanvas'), sctx = sigCanvas.getContext('2d');
const SIG_FONTS = ['"Segoe Script"', '"Brush Script MT"', '"Lucida Handwriting"', '"Ink Free"', '"Segoe Print"', 'cursive'];
const sig = { tab: 'draw', ink: false, style: 0, upload: null };
const SIGKEY = 'pdfstudio.signatures';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(SIGKEY) || '[]'); } catch { return []; } };
const storeSaved = (l) => { try { localStorage.setItem(SIGKEY, JSON.stringify(l.slice(0, 8))); } catch {} };
function renderSaved() {
  const box = $('#sigSaved'); box.innerHTML = '';
  loadSaved().forEach((s, idx) => {
    const d = document.createElement('div'); d.className = 's'; d.title = 'Use this signature';
    const im = new Image(); im.src = s.dataUrl; d.appendChild(im);
    const x = document.createElement('b'); x.textContent = '✕'; x.title = 'Remove';
    x.onclick = (e) => { e.stopPropagation(); const l = loadSaved(); l.splice(idx, 1); storeSaved(l); renderSaved(); };
    d.appendChild(x);
    d.onclick = () => { closeSignature(false); setPending({ dataUrl: s.dataUrl, w: s.w, h: s.h }, 'signature', 170); };
    box.appendChild(d);
  });
}
function openSignature() {
  sctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); sig.ink = false; sig.upload = null;
  $('#sigText').value = ''; buildSigStyles(); setSigTab('draw'); renderSaved();
  sigModal.hidden = false;
}
function closeSignature(resetTool = true) { sigModal.hidden = true; if (resetTool && !S.pending) setTool('select'); }
function setSigTab(t) {
  sig.tab = t;
  $$('.tab', sigModal).forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tabpane', sigModal).forEach((b) => (b.hidden = b.dataset.pane !== t));
  if (t === 'type') setTimeout(() => $('#sigText').focus(), 0);
}
$$('.tab', sigModal).forEach((b) => b.addEventListener('click', () => setSigTab(b.dataset.tab)));
let sigDraw = null;
const sigPt = (e) => { const r = sigCanvas.getBoundingClientRect(); return [(e.clientX - r.left) * sigCanvas.width / r.width, (e.clientY - r.top) * sigCanvas.height / r.height]; };
sigCanvas.addEventListener('pointerdown', (e) => {
  sigCanvas.setPointerCapture(e.pointerId); sigDraw = sigPt(e); sig.ink = true;
  sctx.fillStyle = $('#sigInk').value; sctx.beginPath(); sctx.arc(sigDraw[0], sigDraw[1], 1.8, 0, 7); sctx.fill();
});
sigCanvas.addEventListener('pointermove', (e) => {
  if (!sigDraw) return; const q = sigPt(e);
  sctx.strokeStyle = $('#sigInk').value; sctx.lineWidth = 3.6; sctx.lineCap = 'round'; sctx.lineJoin = 'round';
  sctx.beginPath(); sctx.moveTo(sigDraw[0], sigDraw[1]); sctx.lineTo(q[0], q[1]); sctx.stroke(); sigDraw = q;
});
['pointerup', 'pointercancel'].forEach((ev) => sigCanvas.addEventListener(ev, () => (sigDraw = null)));
$('#sigClear').onclick = () => { sctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); sig.ink = false; };
function buildSigStyles() {
  const box = $('#sigStyles'); box.innerHTML = '';
  SIG_FONTS.forEach((f, i) => {
    const d = document.createElement('div'); d.className = 'sty' + (i === sig.style ? ' active' : ''); d.style.fontFamily = f;
    d.textContent = $('#sigText').value || 'Your Name';
    d.onclick = () => { sig.style = i; buildSigStyles(); }; box.appendChild(d);
  });
}
$('#sigText').addEventListener('input', buildSigStyles);
$('#sigFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { sig.upload = await fileToImage(f, 1600); drawUploadPreview(); } catch (err) { toast(err.message, true); }
});
$('#sigRemoveBg').addEventListener('change', drawUploadPreview);
function processUpload() {
  if (!sig.upload) return null;
  const src = sig.upload.canvas, c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const x = c.getContext('2d'); x.drawImage(src, 0, 0);
  if ($('#sigRemoveBg').checked) {
    const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
    for (let o = 0; o < d.length; o += 4) {
      const m = Math.min(d[o], d[o + 1], d[o + 2]);
      if (m >= 245) d[o + 3] = 0; else if (m > 195) d[o + 3] = Math.round(d[o + 3] * (245 - m) / 50);
    }
    x.putImageData(im, 0, 0);
  }
  return c;
}
function drawUploadPreview() {
  const pv = $('#sigUploadPreview'), px = pv.getContext('2d'); px.clearRect(0, 0, pv.width, pv.height);
  const c = processUpload(); if (!c) return;
  const k = Math.min(pv.width / c.width, pv.height / c.height); px.drawImage(c, (pv.width - c.width * k) / 2, (pv.height - c.height * k) / 2, c.width * k, c.height * k);
}
function trimCanvas(c) {
  const x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) if (d[(y * c.width + xx) * 4 + 3] > 12) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height); return o;
}
$('#sigUse').onclick = () => {
  let src = null;
  if (sig.tab === 'draw') { if (sig.ink) src = sigCanvas; }
  else if (sig.tab === 'type') {
    const txt = $('#sigText').value.trim();
    if (txt) {
      const c = document.createElement('canvas'), x = c.getContext('2d'), font = `110px ${SIG_FONTS[sig.style]}`;
      x.font = font; c.width = Math.ceil(x.measureText(txt).width) + 60; c.height = 190;
      x.font = font; x.fillStyle = $('#sigInk').value; x.textBaseline = 'middle'; x.fillText(txt, 30, 95); src = c;
    }
  } else src = processUpload();
  const t = src && trimCanvas(src);
  if (!t) { toast('Create a signature first.', true); return; }
  const info = { canvas: t, dataUrl: t.toDataURL('image/png'), w: t.width, h: t.height };
  if ($('#sigRemember').checked) { const l = loadSaved(); l.unshift({ dataUrl: info.dataUrl, w: info.w, h: info.h }); storeSaved(l); }
  closeSignature(false); setPending(info, 'signature', 170);
};
$('#sigCancel').onclick = () => closeSignature(true);
sigModal.addEventListener('pointerdown', (e) => { if (e.target === sigModal) closeSignature(true); });

/* ---------------------------------------------------------------- tools UI */
const HINTS = {
  select: 'Click to select · drag to move · double-click text to edit · Del removes',
  edit: 'Click any line of existing text to edit it',
  text: 'Click on the page to type new text',
  signature: 'Click on the page to place your signature',
  image: 'Click on the page to place the image',
  highlight: 'Drag over content to highlight it',
  pen: 'Drag to draw freehand',
  rect: 'Drag to draw a rectangle', ellipse: 'Drag to draw an ellipse',
  line: 'Drag to draw a line (hold Shift to straighten)', arrow: 'Drag to draw an arrow',
  whiteout: 'Drag to cover content. This hides it visually — the text underneath stays in the file.',
};
function setTool(t) {
  if (S.tool === 'text' || S.tool === 'edit') { const ae = document.activeElement; if (ae && ae.isContentEditable) ae.blur(); }
  S.tool = t; viewer.dataset.tool = t;
  $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (t !== 'signature' && t !== 'image') S.pending = null;
  if (t !== 'select' && t !== 'text') select(null);
  updateProps();
  if (S.doc) {
    if (t === 'signature' && !S.pending) openSignature();
    if (t === 'image' && !S.pending) $('#imageFile').click();
  }
}
$$('.tool').forEach((b) => b.addEventListener('click', () => { if (!S.doc) { toast('Open a PDF first.'); return; } setTool(b.dataset.tool); }));

function updateProps() {
  const a = getSel(), t = S.tool, el = $('#props');
  const cls = [];
  const type = a ? a.type : null;
  if (t === 'text' || t === 'edit' || type === 'text') cls.push('show-text');
  const shapeTools = ['rect', 'ellipse', 'line', 'arrow', 'pen'];
  const isShape = (x) => ['rect', 'ellipse', 'line', 'arrow', 'pen'].includes(x);
  if (shapeTools.includes(t) || (type && isShape(type) && a.kind !== 'cover')) cls.push('show-stroke');
  if (t === 'rect' || t === 'ellipse' || ((type === 'rect' || type === 'ellipse') && a.kind !== 'cover')) cls.push('show-fill');
  if (t === 'highlight' || type === 'highlight') cls.push('show-hl');
  if (a) cls.push('show-sel');
  el.className = cls.join(' ');
  const st = S.style, src = a && type === 'text' ? a : st;
  $('#pFont').value = src.font; $('#pSize').value = src.size; $('#pColor').value = src.color;
  $('#pBold').classList.toggle('on', !!src.bold); $('#pItalic').classList.toggle('on', !!src.italic);
  const ss = a && isShape(type) && a.kind !== 'cover' ? a : null;
  $('#pStroke').value = (ss && ss.stroke) || st.stroke; $('#pWidth').value = ss ? ss.sw : st.width;
  const fs = a && (type === 'rect' || type === 'ellipse') && a.kind !== 'cover' ? a : null;
  $('#pFillOn').checked = fs ? !!fs.fill : st.fillOn; $('#pFill').value = (fs && fs.fill) || st.fill;
  $('#pHl').value = a && type === 'highlight' ? a.color : st.hl;
  $('#hint').textContent = S.doc ? HINTS[t] : 'Open a PDF to start.';
}
function mutateSel(key, apply, types) {
  const a = getSel();
  if (a && types.includes(a.type) && a.kind !== 'cover') { pushUndoCoalesced(key + a.id); apply(a); mountAnnot(a); }
}
const bind = (id, evt, fn) => $(id).addEventListener(evt, fn);
bind('#pFont', 'change', (e) => { S.style.font = e.target.value; mutateSel('font', (a) => (a.font = S.style.font), ['text']); });
bind('#pSize', 'input', (e) => { const v = clamp(+e.target.value || 14, 4, 200); S.style.size = v; mutateSel('size', (a) => (a.size = v), ['text']); });
bind('#pBold', 'click', () => { S.style.bold = !S.style.bold; $('#pBold').classList.toggle('on', S.style.bold); mutateSel('bold', (a) => (a.bold = S.style.bold), ['text']); });
bind('#pItalic', 'click', () => { S.style.italic = !S.style.italic; $('#pItalic').classList.toggle('on', S.style.italic); mutateSel('italic', (a) => (a.italic = S.style.italic), ['text']); });
bind('#pColor', 'input', (e) => { S.style.color = e.target.value; mutateSel('color', (a) => (a.color = S.style.color), ['text']); });
bind('#pStroke', 'input', (e) => { S.style.stroke = e.target.value; mutateSel('stroke', (a) => (a.stroke = S.style.stroke), ['rect', 'ellipse', 'line', 'arrow', 'pen']); });
bind('#pWidth', 'input', (e) => { const v = clamp(+e.target.value || 1, 0.5, 40); S.style.width = v; mutateSel('width', (a) => (a.sw = v), ['rect', 'ellipse', 'line', 'arrow', 'pen']); });
bind('#pFillOn', 'change', (e) => { S.style.fillOn = e.target.checked; mutateSel('fillon', (a) => (a.fill = S.style.fillOn ? S.style.fill : null), ['rect', 'ellipse']); });
bind('#pFill', 'input', (e) => { S.style.fill = e.target.value; S.style.fillOn = true; $('#pFillOn').checked = true; mutateSel('fill', (a) => (a.fill = S.style.fill), ['rect', 'ellipse']); });
bind('#pHl', 'input', (e) => { S.style.hl = e.target.value; mutateSel('hl', (a) => (a.color = S.style.hl), ['highlight']); });
bind('#pDel', 'click', deleteSelected);
bind('#pDup', 'click', duplicateSelected);

function fillFontSelect() {
  const sel = $('#pFont'); sel.innerHTML = '';
  const add = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l || v; sel.appendChild(o); };
  add('Helvetica', 'Helvetica (sans)'); add('Times', 'Times (serif)'); add('Courier', 'Courier (mono)');
  S.fonts.forEach((f) => add(f));
  sel.value = S.style.font;
}

/* ------------------------------------------------------------------ zoom & nav */
function setZoom(z) {
  if (!S.doc) return;
  z = clamp(z, 0.25, 4); if (Math.abs(z - S.zoom) < 0.001) return;
  const ratio = (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(1, viewer.scrollHeight);
  S.zoom = z; buildPages();
  viewer.scrollTop = ratio * viewer.scrollHeight - viewer.clientHeight / 2;
  updateUI();
}
function fitWidth() {
  if (!S.doc) return;
  const w = Math.max(...S.pages.map((p) => p.vp.width));
  setZoom((viewer.clientWidth - 64) / w);
}
bind('#zoomIn', 'click', () => setZoom(S.zoom * 1.15));
bind('#zoomOut', 'click', () => setZoom(S.zoom / 1.15));
bind('#zoomFit', 'click', fitWidth);
let wheelT = 0;
viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return; e.preventDefault();
  const now = Date.now(); if (now - wheelT < 90) return; wheelT = now;
  setZoom(S.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
}, { passive: false });
bind('#pageInput', 'change', (e) => { const n = clamp(parseInt(e.target.value) || 1, 1, S.pages.length) - 1; scrollToPage(n); });

/* ------------------------------------------------------------------- search */
async function doSearch(q) {
  S.hits = []; S.hitIdx = -1; q = q.trim().toLowerCase();
  if (!q || !S.doc) { renderHits(); $('#searchCount').textContent = ''; return; }
  for (let i = 0; i < S.pages.length; i++) {
    for (const l of await getLines(i)) {
      const s = l.str.toLowerCase(); let k = s.indexOf(q);
      while (k !== -1) {
        S.hits.push({ page: i, x: l.x + l.w * k / s.length, y: l.top, w: l.w * q.length / s.length, h: l.bottom - l.top });
        k = s.indexOf(q, k + q.length);
      }
    }
  }
  $('#searchCount').textContent = S.hits.length ? '' : 'No matches';
  if (S.hits.length) goHit(0); else renderHits();
}
function goHit(n) {
  if (!S.hits.length) return;
  S.hitIdx = (n + S.hits.length) % S.hits.length; renderHits();
  const h = S.hits[S.hitIdx], p = S.pages[h.page];
  viewer.scrollTop = p.el.offsetTop + h.y * S.zoom - viewer.clientHeight / 3;
  $('#searchCount').textContent = `${S.hitIdx + 1} / ${S.hits.length}`;
}
function renderHits() {
  S.pages.forEach((p) => { if (p.hits) p.hits.innerHTML = ''; });
  S.hits.forEach((h, idx) => {
    const p = S.pages[h.page]; if (!p || !p.hits) return;
    const d = document.createElement('div'); d.className = 'hit' + (idx === S.hitIdx ? ' cur' : '');
    Object.assign(d.style, { left: h.x + 'px', top: h.y + 'px', width: h.w + 'px', height: h.h + 'px' }); p.hits.appendChild(d);
  });
}
function openSearch() {
  if (!S.doc) return; $('#searchBox').hidden = false; const i = $('#searchInput'); i.focus(); i.select();
}
function closeSearch() { $('#searchBox').hidden = true; S.hits = []; renderHits(); $('#searchInput').value = ''; $('#searchCount').textContent = ''; }
bind('#btnFind', 'click', openSearch);
bind('#searchClose', 'click', closeSearch);
bind('#searchNext', 'click', () => goHit(S.hitIdx + 1));
bind('#searchPrev', 'click', () => goHit(S.hitIdx - 1));
bind('#searchInput', 'keydown', (e) => {
  if (e.key === 'Enter') { if (S.hits.length && e.target.dataset.q === e.target.value) goHit(S.hitIdx + (e.shiftKey ? -1 : 1)); else { e.target.dataset.q = e.target.value; doSearch(e.target.value); } }
  if (e.key === 'Escape') closeSearch();
  e.stopPropagation();
});

/* ------------------------------------------------------------- page management */
const targets = () => (S.selPages.size ? [...S.selPages].sort((a, b) => a - b) : [S.curPage]);
async function currentBakedBytes() { return S.annots.length ? buildOutput() : S.bytes; }

// Runs a structural edit on the document. Pending annotations are baked into the PDF first.
async function pageOp(fn) {
  if (!S.doc) return;
  try {
    const before = snap();
    const baked = await currentBakedBytes();
    const pdf = await PDFDocument.load(baked);
    const newSel = await fn(pdf);
    const out = await pdf.save();
    const prevAnnots = S.annots; S.annots = [];
    try { await loadBytes(out, true); } catch (e) { S.annots = prevAnnots; throw e; }
    pushUndo(before);
    S.selected = null;
    S.selPages = new Set(newSel || []); refreshThumbSel();
  } catch (e) { console.error(e); toast('Page operation failed: ' + e.message, true); }
}
const rotatePages = (delta) => { const t = targets(); return pageOp(async (pdf) => { t.forEach((i) => { const pg = pdf.getPage(i); pg.setRotation(degrees((pg.getRotation().angle + delta + 360) % 360)); }); return t; }); };
function deletePages() {
  const t = targets();
  if (t.length >= S.pages.length) { toast('A PDF needs at least one page.', true); return; }
  if (!confirm(`Delete ${t.length} page${t.length > 1 ? 's' : ''}?`)) return;
  return pageOp(async (pdf) => { [...t].reverse().forEach((i) => pdf.removePage(i)); return []; });
}
function reorder(order, newSel) {
  return pageOp(async (pdf) => {
    const pgs = order.map((i) => pdf.getPage(i));
    for (let i = pdf.getPageCount() - 1; i >= 0; i--) pdf.removePage(i);
    pgs.forEach((p) => pdf.addPage(p));
    return newSel;
  });
}
function movePagesTo(pos) {
  const sel = [...S.selPages].sort((a, b) => a - b), n = S.pages.length;
  const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !S.selPages.has(i));
  const k = rest.filter((i) => i < pos).length;
  const order = [...rest.slice(0, k), ...sel, ...rest.slice(k)];
  if (order.every((v, i) => v === i)) return;
  reorder(order, sel.map((_, j) => k + j));
}
function nudgePages(dir) {
  const sel = new Set(targets()), n = S.pages.length, order = Array.from({ length: n }, (_, i) => i);
  if (dir < 0) { for (let i = 1; i < n; i++) if (sel.has(order[i]) && !sel.has(order[i - 1])) [order[i - 1], order[i]] = [order[i], order[i - 1]]; }
  else { for (let i = n - 2; i >= 0; i--) if (sel.has(order[i]) && !sel.has(order[i + 1])) [order[i + 1], order[i]] = [order[i], order[i + 1]]; }
  if (order.every((v, i) => v === i)) return;
  reorder(order, order.map((v, i) => (sel.has(v) ? i : -1)).filter((i) => i >= 0));
}
function blankPage() {
  const t = targets(), idx = t[t.length - 1], vp = S.pages[idx].vp;
  return pageOp(async (pdf) => { pdf.insertPage(idx + 1, [vp.width, vp.height]); return [idx + 1]; });
}
async function insertFromPdf() {
  const files = await api.openDialog({ multi: false }); if (!files) return;
  const t = targets(), idx = t[t.length - 1];
  return pageOp(async (pdf) => {
    const src = await PDFDocument.load(files[0].data);
    const copies = await pdf.copyPages(src, src.getPageIndices());
    copies.forEach((pg, k) => pdf.insertPage(idx + 1 + k, pg));
    return copies.map((_, k) => idx + 1 + k);
  });
}
async function extractPages() {
  try {
    const t = targets(), baked = await currentBakedBytes();
    const src = await PDFDocument.load(baked), dst = await PDFDocument.create();
    (await dst.copyPages(src, t)).forEach((p) => dst.addPage(p));
    const out = await dst.save();
    const r = await api.saveAs({ data: out, defaultName: S.fileName.replace(/\.pdf$/i, '') + '_pages.pdf' });
    if (r) toast(`Saved ${t.length} page${t.length > 1 ? 's' : ''} to ${r.name}`);
  } catch (e) { toast('Extract failed: ' + e.message, true); }
}
bind('#pgRotL', 'click', () => rotatePages(-90));
bind('#pgRotR', 'click', () => rotatePages(90));
bind('#pgUp', 'click', () => nudgePages(-1));
bind('#pgDown', 'click', () => nudgePages(1));
bind('#pgBlank', 'click', blankPage);
bind('#pgInsert', 'click', insertFromPdf);
bind('#pgExtract', 'click', extractPages);
bind('#pgDel', 'click', deletePages);

/* --------------------------------------------------------- export (pdf-lib) */
async function buildOutput() {
  const pdf = await PDFDocument.load(S.bytes);
  pdf.registerFontkit(fontkit);
  const pages = pdf.getPages(), fcache = new Map(), icache = new Map();

  async function fontFor(a, text) {
    let fam = a.font;
    const needsUni = /[^\u0000-ÿ‘’“”–—•€…]/.test(text);
    if (STD[fam] && needsUni && S.fonts.length) fam = S.fonts.includes('Segoe UI') ? 'Segoe UI' : S.fonts[0];
    const k = [fam, !!a.bold, !!a.italic].join('|');
    if (fcache.has(k)) return fcache.get(k);
    let f;
    if (STD[fam]) { f = await pdf.embedFont(StandardFonts[STD[fam][(a.bold ? 1 : 0) + (a.italic ? 2 : 0)]]); f._std = true; }
    else {
      const bytes = api.readFont ? await api.readFont({ family: fam, bold: !!a.bold, italic: !!a.italic }) : null;
      if (bytes) f = await pdf.embedFont(bytes, { subset: true });
      else { f = await pdf.embedFont(StandardFonts.Helvetica); f._std = true; }
    }
    fcache.set(k, f); return f;
  }
  const safe = (f, s) => {
    s = s.replace(/\t/g, '    ');
    if (!f._std) return s;
    try { const cs = new Set(f.getCharacterSet()); return Array.from(s).map((ch) => (cs.has(ch.codePointAt(0)) ? ch : '?')).join(''); } catch { return s; }
  };
  async function imageFor(key) {
    if (icache.has(key)) return icache.get(key);
    const im = S.imgs[key], bytes = dataBytes(im.dataUrl);
    const e = im.mime === 'image/jpeg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    icache.set(key, e); return e;
  }

  for (const a of S.annots) {
    const page = pages[a.page], meta = S.pages[a.page]; if (!page || !meta) continue;
    const vp = meta.vp, rot = degrees(meta.rot);
    const P = (x, y) => { const [ux, uy] = vp.convertToPdfPoint(x, y); return { x: ux, y: uy }; };
    switch (a.type) {
      case 'text': {
        const font = await fontFor(a, a.text), color = hexToRgb(a.color);
        a.text.split('\n').forEach((line, k) => {
          if (!line) return;
          const o = P(a.x, a.y + a.size * 0.94 + k * a.size * 1.2);
          page.drawText(safe(font, line), { x: o.x, y: o.y, size: a.size, font, color, rotate: rot });
        });
        break;
      }
      case 'highlight': {
        const o = P(a.x, a.y + a.h);
        page.drawRectangle({ x: o.x, y: o.y, width: a.w, height: a.h, rotate: rot, color: hexToRgb(a.color), opacity: 0.55, blendMode: BlendMode.Multiply });
        break;
      }
      case 'rect': {
        const o = P(a.x, a.y + a.h), opt = { x: o.x, y: o.y, width: a.w, height: a.h, rotate: rot, borderWidth: a.stroke ? a.sw : 0 };
        if (a.fill) opt.color = hexToRgb(a.fill);
        if (a.stroke && a.sw) opt.borderColor = hexToRgb(a.stroke);
        page.drawRectangle(opt);
        break;
      }
      case 'ellipse': {
        const c = P(a.x + a.w / 2, a.y + a.h / 2), swap = meta.rot % 180 === 90;
        const opt = { x: c.x, y: c.y, xScale: (swap ? a.h : a.w) / 2, yScale: (swap ? a.w : a.h) / 2, borderWidth: a.stroke ? a.sw : 0 };
        if (a.fill) opt.color = hexToRgb(a.fill);
        if (a.stroke && a.sw) opt.borderColor = hexToRgb(a.stroke);
        page.drawEllipse(opt);
        break;
      }
      case 'line': case 'arrow': {
        const col = hexToRgb(a.stroke), seg = (p1, p2) => page.drawLine({ start: P(p1[0], p1[1]), end: P(p2[0], p2[1]), thickness: a.sw, color: col, lineCap: LineCapStyle.Round });
        seg([a.x1, a.y1], [a.x2, a.y2]);
        if (a.type === 'arrow') { const h = arrowHead(a); seg(h[0], [a.x2, a.y2]); seg(h[1], [a.x2, a.y2]); }
        break;
      }
      case 'pen': {
        const col = hexToRgb(a.stroke);
        for (let k = 1; k < a.pts.length; k++) page.drawLine({ start: P(...a.pts[k - 1]), end: P(...a.pts[k]), thickness: a.sw, color: col, lineCap: LineCapStyle.Round });
        break;
      }
      case 'image': {
        const img = await imageFor(a.img), o = P(a.x, a.y + a.h);
        page.drawImage(img, { x: o.x, y: o.y, width: a.w, height: a.h, rotate: rot });
        break;
      }
    }
  }
  return pdf.save();
}

/* --------------------------------------------------------- open / save flow */
async function confirmDiscard() { return !S.dirty || confirm('You have unsaved changes. Discard them?'); }
async function openBytes(bytes, name, path) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    try { await PDFDocument.load(bytes); }
    catch (e) {
      if (/encrypt/i.test(e.message)) throw new Error('This PDF is encrypted, so it can’t be edited here yet.');
      throw new Error('This file can’t be edited: ' + e.message);
    }
    await loadBytes(bytes, false);
  } catch (e) { console.error(e); toast(e.message, true); return false; }
  Object.assign(S, { annots: [], imgs: {}, undo: [], redo: [], selected: null, fileName: name || 'document.pdf', origPath: path || null, savePath: null, selPages: new Set(), lastSel: null, curPage: 0, hits: [], pending: null });
  setTool('select'); fitWidthInitial(); setDirty(false); updateUI();
  return true;
}
function fitWidthInitial() {
  const w = Math.max(...S.pages.map((p) => p.vp.width));
  const z = clamp((viewer.clientWidth - 64) / w, 0.5, 1.6);
  S.zoom = z; buildPages();
}
async function openFlow() {
  if (!(await confirmDiscard())) return;
  const r = await api.openDialog({}); if (r) openBytes(r[0].data, r[0].name, r[0].path);
}
async function save(forceAs) {
  if (!S.doc) return false;
  try {
    toast('Saving…');
    const out = await buildOutput();
    let r;
    if (forceAs || !S.savePath) {
      const defaultName = S.origPath ? S.origPath.replace(/\.pdf$/i, '') + '_edited.pdf' : S.fileName.replace(/\.pdf$/i, '') + '_edited.pdf';
      r = await api.saveAs({ data: out, defaultName });
    } else r = await api.save({ data: out, path: S.savePath });
    if (!r) { $('#toast').hidden = true; return false; }
    S.savePath = r.path; S.fileName = r.name; setDirty(false); toast('Saved ' + r.name);
    return true;
  } catch (e) { console.error(e); toast('Save failed: ' + e.message, true); return false; }
}
bind('#btnOpen', 'click', openFlow);
bind('#emptyOpen', 'click', openFlow);
bind('#btnSave', 'click', () => save(false));
bind('#btnSaveAs', 'click', () => save(true));
bind('#btnUndo', 'click', undo);
bind('#btnRedo', 'click', redo);

if (api.onCommand) api.onCommand(async (c) => {
  if (c === 'open') openFlow();
  else if (c === 'save') save(false);
  else if (c === 'save-as') save(true);
  else if (c === 'save-and-close') { if (await save(false)) api.closeNow(); }
});
if (api.onOpenPath) api.onOpenPath(async (p) => {
  if (!(await confirmDiscard())) return;
  const f = await api.readFile(p); openBytes(f.data, f.name, f.path);
});

// drag & drop a PDF from Explorer
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; viewer.classList.add('dragover'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; viewer.classList.remove('dragover'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; viewer.classList.remove('dragover');
  const f = Array.from(e.dataTransfer.files).find((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
  if (!f) { toast('Drop a .pdf file.', true); return; }
  if (!(await confirmDiscard())) return;
  openBytes(new Uint8Array(await f.arrayBuffer()), f.name, null);
});

/* ---------------------------------------------------------------- keyboard */
const TOOL_KEYS = { v: 'select', e: 'edit', t: 'text', s: 'signature', i: 'image', h: 'highlight', p: 'pen', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout' };
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName, typing = e.target.isContentEditable || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'f') { e.preventDefault(); openSearch(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom(S.zoom * 1.15); return; }
  if (mod && k === '-') { e.preventDefault(); setZoom(S.zoom / 1.15); return; }
  if (mod && k === '0') { e.preventDefault(); fitWidth(); return; }
  if (typing || !S.doc && !mod) return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod) return;
  if (k === 'delete' || k === 'backspace') { if (getSel()) { e.preventDefault(); deleteSelected(); } return; }
  if (k === 'escape') { if (!$('#sigModal').hidden) closeSignature(true); else { select(null); setTool('select'); } return; }
  if (k.startsWith('arrow') && getSel()) {
    e.preventDefault(); const a = getSel(), d = e.shiftKey ? 10 : 1;
    const dx = k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, dy = k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0;
    pushUndoCoalesced('nudge' + a.id);
    for (const key of ['x', 'x1', 'x2']) if (key in a) a[key] += dx;
    for (const key of ['y', 'y1', 'y2']) if (key in a) a[key] += dy;
    if (a.pts) a.pts = a.pts.map((q) => [q[0] + dx, q[1] + dy]);
    mountAnnot(a); return;
  }
  if (TOOL_KEYS[k] && S.doc) setTool(TOOL_KEYS[k]);
});

/* ---------------------------------------------------------------- UI state */
function updateUI() {
  const has = !!S.doc;
  $('#empty').style.display = has ? 'none' : 'flex';
  ['btnSave', 'btnSaveAs', 'btnFind', 'zoomIn', 'zoomOut', 'zoomFit', 'pgRotL', 'pgRotR', 'pgUp', 'pgDown', 'pgBlank', 'pgInsert', 'pgExtract', 'pgDel'].forEach((id) => ($('#' + id).disabled = !has));
  $('#pageInput').disabled = !has;
  $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
  $('#zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  $('#pageTotal').textContent = '/ ' + S.pages.length; $('#pageInput').max = S.pages.length;
  $('#pageInput').value = S.curPage + 1;
  updateProps();
}

/* -------------------------------------------------------------------- init */
fillFontSelect(); updateUI();
if (api.listFonts) api.listFonts().then((f) => { S.fonts = f || []; fillFontSelect(); }).catch(() => {});
if (/[?&]test\b/.test(location.search)) window.__t = { S, openBytes, buildOutput, setTool, getLines, select, mountAnnot, setZoom, pageOp, movePagesTo, nudgePages, rotatePages, undo, redo, pushUndo, snap, setPending, storeImage, extractPages };
})();
