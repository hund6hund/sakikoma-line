// 崎駒線 運行記録アプリ：画面

import * as db from './db.js';
import {
  computeKm, hasCoord, dist, esc, fmtDate, fmtClock, fmtDateTime, fmtDur, fmtSigned, parseDur,
  download, TYPE_LABEL, SRC_LABEL, DIR_LABEL, DEFAULT_SETTINGS, WEEKDAYS, inBand, median,
} from './util.js';
import { RunEngine, replay } from './engine.js';
import { GeoLocator, SimLocator, SIM, clock, getOnce } from './locator.js';
import * as ana from './analysis.js';
import * as ex from './exporter.js';
import {
  unlock as unlockSound, chime, soundState, resume as resumeSound, reset as resetSound,
  prepareFiles, setMethod as setSoundMethod, beepTest,
} from './sound.js';
import { gaugeSvg, setGauge } from './gauge.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');

const app = {
  stations: [], // computeKm 済み
  settings: { ...DEFAULT_SETTINGS },
  dias: [],
  tab: 'cab',
  cur: null, // 運転中の状態
  resumeRun: null, // 中断していた運転
  selDir: null,
};

// ====================================================================
// 起動・共通
// ====================================================================
async function loadAll() {
  app.stations = computeKm(await db.all('stations'));
  app.settings = { ...DEFAULT_SETTINGS, ...(await db.getKv('settings', {})) };
  app.dias = (await db.all('dias')).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  document.documentElement.dataset.theme = app.settings.theme;
  setSoundMethod(app.settings.chimeMethod);
}

async function init() {
  await db.open();
  await loadAll();
  app.resumeRun = (await db.all('runs')).find((r) => r.status === 'running') || null;
  $$('#nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  if (SIM) $('#simBadge').hidden = false;
  prepareFiles();
  show('cab');
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function show(tab, arg) {
  if (app.cur && tab !== 'cab') return; // 運転中は運転台から離れない
  app.tab = tab;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  const r = { cab: renderCab, runs: renderRuns, ledger: renderLedger, dia: renderDias, analysis: renderAnalysis, data: renderData }[tab];
  r(arg);
}

function dialog(html, onMount) {
  const dlg = $('#dlg');
  dlg.innerHTML = html;
  dlg.showModal();
  onMount?.(dlg);
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
  return dlg;
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = async () => resolve(inp.files[0] ? await inp.files[0].text() : null);
    inp.click();
  });
}

const usable = () => app.stations.filter(hasCoord);
function ends() {
  const asc = usable().sort((a, b) => a.km - b.km);
  return { home: asc[0] ?? null, campus: asc[asc.length - 1] ?? null };
}

async function saveSettings(patch) {
  app.settings = { ...app.settings, ...patch };
  await db.setKv('settings', app.settings);
  document.documentElement.dataset.theme = app.settings.theme;
}

// ====================================================================
// 運転台（待機）
// ====================================================================
function renderCab() {
  if (app.cur) return renderCabRunning();
  if (app.resumeRun) return renderResume();
  const { home, campus } = ends();
  const ok = usable().length >= 2;
  app.selDir ||= 'down';
  view.innerHTML = `
    <section class="idle">
      <h1 class="plate">崎駒線 運転台</h1>
      ${ok ? '' : `<p class="warn">座標を入れた駅が2つ以上必要です。「台帳」で駅を登録してください。</p>`}
      <div class="dirsel">
        <button data-dir="down" class="dirbtn">下り<small>${esc(home?.name ?? '起点')} → ${esc(campus?.name ?? '終点')}</small></button>
        <button data-dir="up" class="dirbtn">上り<small>${esc(campus?.name ?? '終点')} → ${esc(home?.name ?? '起点')}</small></button>
      </div>
      <p id="suggest" class="muted">現在地から行先を提案しています…</p>
      <label class="row">ダイヤ <select id="diaSel"></select></label>
      <button id="btnStart" class="btn-start" ${ok ? '' : 'disabled'}>運転開始</button>
      <p class="muted small">運転開始は乗車前に起点で押してください。走行中の操作は不要です。</p>
    </section>`;
  const paint = () => {
    $$('.dirbtn').forEach((b) => b.classList.toggle('on', b.dataset.dir === app.selDir));
    const opts = [['auto', '自動（時刻と行先から選ぶ）'], ['none', 'なし'], ...app.dias.filter((d) => d.direction === app.selDir).map((d) => [d.id, d.name])];
    $('#diaSel').innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  };
  $$('.dirbtn').forEach((b) => b.addEventListener('click', () => { app.selDir = b.dataset.dir; paint(); }));
  $('#btnStart').addEventListener('click', () => {
    unlockSound();
    startRun(app.selDir, $('#diaSel').value);
  });
  paint();
  if (!ok || SIM) {
    $('#suggest').textContent = SIM ? '模擬走行モード（?sim）' : '';
    return;
  }
  getOnce()
    .then((pos) => {
      if (app.cur || app.tab !== 'cab' || !$('#suggest')) return;
      const dh = dist(pos, home);
      const dc = dist(pos, campus);
      app.selDir = dh <= dc ? 'down' : 'up';
      paint();
      $('#suggest').textContent = `現在地は${dh <= dc ? home.name : campus.name}に近い（${Math.round(Math.min(dh, dc))} m、精度 ±${Math.round(pos.acc)} m）→ ${DIR_LABEL[app.selDir]}を提案`;
    })
    .catch((e) => { if ($('#suggest')) $('#suggest').textContent = `現在地を取得できません（${e.message}）`; });
}

function renderResume() {
  const r = app.resumeRun;
  view.innerHTML = `
    <section class="idle">
      <h1 class="plate">運転が中断しています</h1>
      <p class="big">${esc(r.trainNo)}　${DIR_LABEL[r.direction]}</p>
      <p>起点発車 ${fmtDateTime(r.startTime, 0)}</p>
      <button id="btnCont" class="btn-start">運転継続</button>
      <button id="btnStop" class="btn">ここまでで運転終了</button>
    </section>`;
  $('#btnCont').addEventListener('click', async () => {
    unlockSound();
    const track = await loadTrack(r.id);
    app.resumeRun = null;
    beginRunning(r, track);
  });
  $('#btnStop').addEventListener('click', async () => {
    await recompute(r, { close: true });
    app.resumeRun = null;
    renderCab();
  });
}

async function loadTrack(runId) {
  return (await db.byIndex('track', 'runId', runId)).sort((a, b) => a.t - b.t);
}

// ====================================================================
// 運転
// ====================================================================
async function startRun(direction, diaSel) {
  const t = clock.now();
  const date = fmtDate(t);
  const n = (await db.all('runs')).filter((r) => r.date === date && r.direction === direction).length;
  const dia = diaSel === 'auto' ? ana.pickDia(app.dias, direction, t) : diaSel === 'none' ? null : app.dias.find((d) => d.id === diaSel) ?? null;
  const run = {
    id: `r${Math.round(t)}`,
    trainNo: `${date.replace(/-/g, '')}-${direction === 'down' ? '下' : '上'}${n + 1}`,
    date,
    direction,
    startTime: t,
    status: 'running',
    arrivalTime: null,
    endTime: null,
    warnings: [],
    diaId: dia?.id ?? null,
    flagCount: 0,
    sim: !!SIM,
  };
  await db.put('runs', run);
  beginRunning(run, []);
}

function makeEngine(run, cur) {
  return new RunEngine({
    run,
    stations: app.stations,
    settings: app.settings,
    on: {
      passage: (pa) => {
        db.put('passages', { ...pa });
        // 確定した通過ごとに一度だけ鳴らす（推定と、到着時の終点は除く）
        if (cur.replaying || pa.estimated || cur.chimed.has(pa.id)) return;
        cur.chimed.add(pa.id);
        if (!(pa.stationId === cur.engine.terminal?.id && pa.exitT == null)) chime('pass', app.settings.chimeVol);
      },
      stop: (s) => db.put('stops', { ...s }),
      arrive: () => { if (!cur.replaying) setTimeout(() => endRun('arrive'), 0); },
      warning: (msg) => {
        if (!run.warnings.includes(msg)) {
          run.warnings.push(msg);
          db.put('runs', run);
        }
      },
    },
  });
}

/** 終了済みの運転の区間集計をそろえる（古い運転は軌跡から計算して保存）。runId -> 集計 */
async function ensureStats(runs) {
  const out = new Map();
  for (const r of runs) {
    if (r.status !== 'done') continue;
    if (r.statsV !== ana.STATS_VERSION || !r.sectionStats) {
      const ps = await db.byIndex('passages', 'runId', r.id);
      r.sectionStats = ana.runSectionStats(ps, await loadTrack(r.id), app.settings.stopKmh);
      r.statsV = ana.STATS_VERSION;
      await db.put('runs', r);
    }
    out.set(r.id, r.sectionStats);
  }
  return out;
}

/** 走行中に使う「いつものペース」を過去の運転から作る（運転開始後に裏で） */
async function loadPace(cur) {
  try {
    const runs = (await db.all('runs')).filter((r) => r.id !== cur.run.id);
    const statsByRun = await ensureStats(runs);
    const passagesByRun = groupBy(await db.all('passages'), 'runId');
    const waits = (await db.all('stops')).filter((x) => x.stationId && x.flag);
    cur.pace = ana.buildPace({
      runs, statsByRun, passagesByRun, waits,
      direction: cur.run.direction, startTime: cur.run.startTime,
      bands: app.settings.bands, capKmh: app.settings.reqCapKmh,
    });
  } catch (e) {
    console.warn('ペースを作れませんでした', e);
  }
}

async function beginRunning(run, track) {
  const cur = { run, dia: app.dias.find((d) => d.id === run.diaId) ?? null, ended: false, replaying: true, err: null, chimed: new Set() };
  cur.engine = makeEngine(run, cur);
  replay(cur.engine, track, run.pauses);
  cur.replaying = false;
  app.cur = cur;
  document.body.classList.add('running');
  show('cab');
  if (cur.engine.arrived) return endRun('arrive');
  cur.timer = setInterval(updateCab, 500);
  loadPace(cur);
  // 一時停止中に落ちていたら、一時停止のまま戻る
  if (run.pauses?.length && run.pauses[run.pauses.length - 1].end == null) {
    cur.paused = true;
    updateCab();
    return;
  }
  await startLocating(cur);
}

async function startLocating(cur) {
  await acquireWake();
  cur.locator = SIM ? new SimLocator(cur.engine.route) : new GeoLocator();
  cur.locator.start(onFix, (err) => { cur.err = err.message || String(err); updateCab(); });
}

/** 一時停止／再開（停止ボタンの短押し）。一時停止中は測位を止め、停車も記録しない */
async function togglePause() {
  const cur = app.cur;
  if (!cur || cur.ended) return;
  const run = cur.run;
  run.pauses ||= [];
  const now = clock.now();
  if (!cur.paused) {
    cur.paused = true;
    cur.locator?.stop();
    cur.locator = null;
    cur.engine.pause();
    run.pauses.push({ start: now, end: null });
    releaseWake();
  } else {
    cur.paused = false;
    run.pauses[run.pauses.length - 1].end = now;
    cur.err = null;
    await startLocating(cur);
  }
  await db.put('runs', run);
  updateCab();
}

function onFix(fix) {
  const cur = app.cur;
  if (!cur || cur.ended || cur.paused) return;
  cur.err = null;
  const p = cur.engine.feed(fix);
  db.put('track', { runId: cur.run.id, t: p.t, lat: p.lat, lon: p.lon, acc: p.acc, speedRaw: p.speedRaw, speed: p.speed, poor: p.poor });
  updateCab();
}

async function endRun(reason) {
  const cur = app.cur;
  if (!cur || cur.ended) return;
  cur.ended = true;
  cur.locator?.stop();
  clearInterval(cur.timer);
  releaseWake();
  const now = clock.now();
  const run = cur.run;
  const lastPause = run.pauses?.[run.pauses.length - 1];
  if (lastPause && lastPause.end == null) lastPause.end = now;
  run.arrivalTime = reason === 'arrive' ? cur.engine.arrivalT : cur.engine.finish(now);
  run.status = 'done';
  run.endTime = now;
  run.endReason = reason;
  run.flagCount = cur.engine.passages.filter((p) => p.stopFlag).length;
  run.warnings = [...new Set([...run.warnings, ...cur.engine.warnings])];
  run.sectionStats = ana.runSectionStats(cur.engine.passages, cur.engine.pts, app.settings.stopKmh);
  run.statsV = ana.STATS_VERSION;
  await db.put('runs', run);
  if (reason === 'arrive') chime('arrive', app.settings.chimeVol);
  app.cur = null;
  document.body.classList.remove('running');
  renderArrival(run, cur.engine);
}

async function acquireWake() {
  try {
    if ('wakeLock' in navigator && app.cur) {
      app.cur.wake = await navigator.wakeLock.request('screen');
    }
  } catch { /* 取得できなくても記録は続ける */ }
}
function releaseWake() {
  app.cur?.wake?.release().catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.cur && !app.cur.ended) {
    acquireWake();
    resumeSound();
  }
});
// 運転中に画面のどこかに触れたら、止まっていた音声を再開する（触れることがブラウザの許可条件）
document.addEventListener('pointerdown', () => { if (app.cur) unlockSound(); }, true);

// ---------------- 運転台（運転中） ----------------
function renderCabRunning() {
  view.innerHTML = `
    <section class="cab">
      <div class="cab-head">
        <span id="cTrain" class="trainno"></span>
        <span id="cDir" class="dir"></span>
        <span id="cGps" class="gps"></span>
      </div>
      <div class="panel">
        <div class="ptag-row"><span class="ptag">次駅</span><span id="cNextSub" class="ptag-note"></span></div>
        <div class="next-row"><span id="cNext" class="cab-next"></span><span class="next-remain"><span class="ro-l">あと</span> <span id="cRemain" class="seg"></span></span></div>
        <!-- 時刻は網の目に置く：横は現在と次駅予定を見比べ、縦は現在と着予想を見比べる。
             左の列は実際と予測、右の列は計画とのずれ -->
        <div class="tgrid">
          <div class="ro"><div class="ro-l">現在</div><div id="cNow" class="seg ro-v"></div></div>
          <div class="ro"><div class="ro-l">次駅予定</div><div id="cSched" class="seg ro-v c-plan"></div></div>
          <div class="ro ro-eta"><div class="ro-l">着予想 <span id="cEtaDest" class="dest"></span></div><div id="cEta" class="seg ro-v c-eta"></div></div>
          <div class="ro ro-diff"><div class="ro-l">定時差</div><div id="cDiff" class="seg"></div></div>
        </div>
      </div>
      <div id="cStrip" class="strip">
        <span class="strip-run"><span class="ptag">前駅</span><span id="cPrev" class="prev"></span><span id="cPrevTime" class="prevtime"></span><span id="cPrevFlag" class="prevflag"></span><span id="cStop" class="stopbadge"></span></span>
        <span class="strip-pause">一時停止中 <span id="cPauseT" class="seg"></span><span class="pausehint">短押しで再開</span></span>
      </div>
      <div id="cGauge" class="cab-gauge">${gaugeSvg(app.settings.reqCapKmh)}</div>
      <div class="cab-foot">
        <span id="cElapsed"></span>
        <button id="btnStop" class="stopbtn" type="button"><span class="stopbtn-fill"></span><span class="stopbtn-label"><b id="cStopLbl">一時停止</b><small>長押しで運転終了</small></span></button>
      </div>
    </section>`;
  bindStopButton($('#btnStop'));
  updateCab();
}

/**
 * 停止ボタン：短押し（0.5秒未満）で一時停止／再開、1.5秒の長押しで運転終了（押しているあいだ赤い帯が伸びる）。
 * 長押しを途中でやめた（0.5〜1.5秒で離した）ときは何もしない。走行中（時速5km/h以上）は一時停止しない。
 */
const HOLD_MS = 1500;
const TAP_MS = 500;
const PAUSE_MAX_KMH = 5; // これ以上の速さでは短押しの一時停止を受け付けない
function bindStopButton(btn) {
  let timer = null;
  let fired = false;
  let downAt = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('holding');
  };
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    fired = false;
    downAt = performance.now();
    btn.classList.add('holding');
    timer = setTimeout(() => {
      fired = true;
      cancel();
      endRun('manual');
    }, HOLD_MS);
  });
  btn.addEventListener('pointerup', () => {
    const short = timer && !fired && performance.now() - downAt < TAP_MS;
    cancel();
    if (!short) return;
    const cur = app.cur;
    const v = cur?.engine.status(clock.now()).speedKmh;
    if (cur && !cur.paused && v != null && v >= PAUSE_MAX_KMH) {
      // 走行中に触れただけで記録が止まらないよう、停車してからでないと一時停止しない
      cur.pauseRefusedUntil = performance.now() + 1500;
      updateCab();
      return;
    }
    togglePause();
  });
  btn.addEventListener('pointercancel', cancel);
}

function setText(sel, text, cls) {
  const el = $(sel);
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  if (cls !== undefined && el.dataset.state !== cls) el.dataset.state = cls;
}

/** 時:分を大きく、秒を上付きの小さな数字で（鉄道の時刻表示に倣う） */
function setClockSup(sel, t) {
  const el = $(sel);
  if (!el) return;
  const s = t == null ? '--:--:--' : fmtClock(t);
  if (el.dataset.v !== s) {
    el.dataset.v = s;
    el.innerHTML = `${s.slice(0, 5)}<span class="sec">${s.slice(6, 8)}</span>`;
  }
  const state = t == null ? 'none' : '';
  if (el.dataset.state !== state) el.dataset.state = state;
}

function updateCab() {
  const cur = app.cur;
  if (!cur || !$('#cNext')) return;
  const now = clock.now();
  const S = app.settings;
  const run = cur.run;
  const dia = cur.dia;
  const st = cur.engine.status(now);
  const el = (now - run.startTime) / 1000;

  setText('#cTrain', run.trainNo);
  setText('#cDir', `${DIR_LABEL[run.direction]}${dia ? '・' + dia.name : ''}`);
  let gps;
  let gcls;
  if (cur.paused) { gps = 'GPS 停止中'; gcls = 'paused'; }
  else if (cur.err && (st.fixAge == null || st.fixAge > 5)) { gps = 'GPS 異常'; gcls = 'bad'; }
  else if (st.fixAge == null) { gps = 'GPS 待機'; gcls = 'bad'; }
  else if (st.fixAge > 10) { gps = `GPS 途絶 ${Math.round(st.fixAge)}s`; gcls = 'bad'; }
  else { gps = `GPS ±${Math.round(st.acc)}m`; gcls = st.poor ? 'bad' : st.acc <= 15 ? 'good' : 'fair'; }
  setText('#cGps', gps, gcls);

  setText('#cNext', st.next ? st.next.name : '（終点）', st.inside ? 'inside' : '');
  setText('#cNextSub', st.next ? `${st.inside ? '構内　' : ''}${st.next.km.toFixed(3)} km` : '', st.inside ? 'inside' : '');
  setText('#cEtaDest', cur.engine.terminal?.name ?? '');

  const schedNext = dia && st.next ? dia.entries[st.next.id] ?? null : null;
  setText('#cNow', fmtClock(now));
  // ダイヤがなくても予定の窓は同じ場所に置き、薄い「--:--:--」にする（配置を変えない）
  setText('#cSched', schedNext == null ? '--:--:--' : fmtClock(run.startTime + schedNext * 1000), schedNext == null ? 'none' : '');
  setText('#cElapsed', `発 ${fmtClock(run.startTime)}　経過 ${fmtDur(el)}`);
  const lastPause = run.pauses?.[run.pauses.length - 1];
  $('.cab').dataset.paused = cur.paused ? '1' : '';
  if (cur.paused && lastPause) setText('#cPauseT', fmtDur((now - lastPause.start) / 1000));
  const refused = cur.pauseRefusedUntil && performance.now() < cur.pauseRefusedUntil;
  setText('#cStopLbl', refused ? '停車してから' : cur.paused ? '再開' : '一時停止');
  const route = cur.engine.route;
  const eta = ana.estimateArrival(cur.pace, {
    lastPassage: st.lastPassage, originId: route[0]?.id, now, dia, terminalId: route[route.length - 1]?.id,
  });
  setClockSup('#cEta', eta);

  let diff = null;
  if (dia) {
    const lp = st.lastPassage;
    const sl = lp ? dia.entries[lp.stationId] : null;
    if (sl != null) diff = (lp.passT - run.startTime) / 1000 - sl;
    if (schedNext != null && el > schedNext) diff = Math.max(diff ?? -Infinity, el - schedNext);
  }
  setText('#cDiff', diff == null ? '--:--' : fmtSigned(diff), diff == null ? 'none' : diff >= 1 ? 'late' : 'ontime');

  setText('#cRemain', st.remain == null ? '--' : st.remain >= 1000 ? `${(st.remain / 1000).toFixed(2)} km` : `${Math.round(st.remain)} m`);
  // 区間の目安速度（過去の運転から。数字は出さず、時速計の緑の印だけで示す）
  const fromId = st.lastPassage?.stationId ?? route[0]?.id;
  const guide = st.next ? cur.pace?.guide[`${fromId}>${st.next.id}`] ?? null : null;
  setGauge($('#cGauge'), cur.paused || st.speedKmh == null || st.fixAge > 10 ? null : st.speedKmh, cur.paused ? null : guide);

  const lp = st.lastPassage;
  setText('#cPrev', lp ? lp.stationName : '—');
  setText('#cPrevTime', lp ? fmtClock(lp.passT) : '');
  setText('#cPrevFlag', lp?.stopFlag ? '■停' : '');
  setText('#cStop', st.stopping != null ? `停車 ${fmtDur(st.stopping)}` : '');
  $('.cab').dataset.stopping = st.stopping != null ? '1' : '';
}

const fmtKmh = (v) => (v == null ? '—' : `${v.toFixed(1)} km/h`);

function renderArrival(run, engine) {
  const dur = run.arrivalTime ? (run.arrivalTime - run.startTime) / 1000 : null;
  view.innerHTML = `
    <section class="idle">
      <h1 class="plate">${run.endReason === 'arrive' ? '到着' : '運転終了'}</h1>
      <p class="big">${esc(run.trainNo)}　${DIR_LABEL[run.direction]}</p>
      <table class="kv">
        <tr><th>起点発車</th><td>${fmtClock(run.startTime)}</td></tr>
        <tr><th>到着</th><td>${run.arrivalTime ? fmtClock(run.arrivalTime) : '—'}</td></tr>
        <tr><th>所要時間</th><td>${fmtDur(dur)}</td></tr>
        <tr><th>通過駅</th><td>${engine.passages.length}（推定 ${engine.passages.filter((p) => p.estimated).length}）</td></tr>
        <tr><th>停車フラグ</th><td>${run.flagCount}</td></tr>
        <tr><th>最高時速</th><td>${fmtKmh(ana.maxSpeed(engine.pts, run.startTime, run.arrivalTime ?? run.endTime))}</td></tr>
      </table>
      ${run.warnings.length ? `<p class="warn">${run.warnings.map(esc).join('<br>')}</p>` : ''}
      <button id="btnDetail" class="btn">記録を見る</button>
      <button id="btnBack" class="btn">運転台へ</button>
    </section>`;
  $('#btnDetail').addEventListener('click', () => show('runs', run.id));
  $('#btnBack').addEventListener('click', () => renderCab());
}

// ====================================================================
// 記録
// ====================================================================
async function renderRuns(runId) {
  if (runId) return renderRunDetail(runId);
  const runs = (await db.all('runs')).sort((a, b) => b.startTime - a.startTime);
  view.innerHTML = `
    <section class="page">
      <h2>運転の記録</h2>
      ${runs.length ? '' : '<p class="muted">まだ記録がありません。</p>'}
      <div class="tblwrap"><table class="tbl clickable">
        <thead><tr><th>日付</th><th>列車番号</th><th>行先</th><th>発</th><th>着</th><th>所要</th><th>停</th></tr></thead>
        <tbody>${runs.map((r) => `
          <tr data-id="${esc(r.id)}">
            <td>${esc(r.date.slice(5))}(${WEEKDAYS[new Date(r.startTime).getDay()]})</td>
            <td>${esc(r.trainNo)}${r.sim ? ' <small>模擬</small>' : ''}${r.warnings?.length ? ' <span class="warn-dot">!</span>' : ''}</td>
            <td>${DIR_LABEL[r.direction]}</td>
            <td class="num">${fmtClock(r.startTime).slice(0, 5)}</td>
            <td class="num">${r.status === 'running' ? '運転中' : r.arrivalTime ? fmtClock(r.arrivalTime).slice(0, 5) : '—'}</td>
            <td class="num">${r.arrivalTime ? fmtDur((r.arrivalTime - r.startTime) / 1000) : '—'}</td>
            <td class="num">${r.flagCount ?? 0}</td>
          </tr>`).join('')}
        </tbody></table></div>
    </section>`;
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => renderRunDetail(tr.dataset.id)));
}

async function renderRunDetail(id) {
  const run = await db.get('runs', id);
  if (!run) return renderRuns();
  const ps = (await db.byIndex('passages', 'runId', id)).sort((a, b) => a.passT - b.passT);
  const ss = (await db.byIndex('stops', 'runId', id)).sort((a, b) => a.startT - b.startT);
  const secs = ana.sections(ps);
  const track = await loadTrack(id);
  const vmax = (t0, t1) => ana.maxSpeed(track, t0, t1);
  const nameOf = (sid) => ps.find((p) => p.stationId === sid)?.stationName ?? app.stations.find((s) => s.id === sid)?.name ?? sid;
  const secName = (sec) => sec ? sec.split('-').map(nameOf).join('→') : '';
  const el = (t) => fmtDur((t - run.startTime) / 1000);
  const real = ps.filter((p) => !p.estimated);
  view.innerHTML = `
    <section class="page">
      <button class="btn btn-small" id="back">← 一覧</button>
      <h2>${esc(run.trainNo)}　${DIR_LABEL[run.direction]}${run.sim ? '（模擬）' : ''}</h2>
      <table class="kv">
        <tr><th>起点発車</th><td>${fmtDateTime(run.startTime, 0)}</td></tr>
        <tr><th>到着</th><td>${run.arrivalTime ? fmtDateTime(run.arrivalTime, 1) : '—'}${run.endReason === 'manual' ? '（手動終了）' : ''}</td></tr>
        <tr><th>所要時間</th><td>${run.arrivalTime ? fmtDur((run.arrivalTime - run.startTime) / 1000) : '—'}</td></tr>
        <tr><th>最高時速</th><td>${fmtKmh(vmax(run.startTime, run.arrivalTime ?? run.endTime))}</td></tr>
        <tr><th>ダイヤ</th><td>${esc(app.dias.find((d) => d.id === run.diaId)?.name ?? 'なし')}</td></tr>
        ${run.pauses?.length ? `<tr><th>一時停止</th><td>${run.pauses.length}回（計 ${fmtDur(run.pauses.reduce((a, q) => a + ((q.end ?? q.start) - q.start), 0) / 1000)}）</td></tr>` : ''}
      </table>
      ${run.warnings?.length ? `<p class="warn">${run.warnings.map(esc).join('<br>')}</p>` : ''}

      <h3>通過</h3>
      <div class="tblwrap"><table class="tbl">
        <thead><tr><th>駅</th><th>キロ程</th><th>通過時刻</th><th>経過</th><th>停車</th><th>距離</th></tr></thead>
        <tbody>${ps.map((p) => `
          <tr class="${p.estimated ? 'est' : ''}">
            <td>${esc(p.stationName)}${p.estimated ? ' <small>推定</small>' : ''}${p.orderWarn ? ' <span class="warn-dot">!</span>' : ''}</td>
            <td class="num">${p.km.toFixed(3)}</td>
            <td class="num">${fmtClock(p.passT, 1)}</td>
            <td class="num">${el(p.passT)}</td>
            <td class="num">${p.stopFlag ? '■' : ''}${p.stopSec ? Math.round(p.stopSec) + 's' : ''}</td>
            <td class="num">${Math.round(p.minDist)}m</td>
          </tr>`).join('')}</tbody></table></div>

      <h3>区間</h3>
      <div class="tblwrap"><table class="tbl">
        <thead><tr><th>区間</th><th>km</th><th>所要</th><th>平均</th><th>最高</th></tr></thead>
        <tbody>${secs.map((s) => `
          <tr class="${s.estimated ? 'est' : ''}">
            <td>${esc(s.from.stationName)}→${esc(s.to.stationName)}</td>
            <td class="num">${s.km.toFixed(3)}</td>
            <td class="num">${fmtDur(s.sec)}</td>
            <td class="num">${s.kmh == null ? '—' : s.kmh.toFixed(1)}</td>
            <td class="num">${vmax(s.from.passT, s.to.passT)?.toFixed(1) ?? '—'}</td>
          </tr>`).join('')}</tbody></table></div>

      <h3>停車</h3>
      <div class="tblwrap"><table class="tbl">
        <thead><tr><th>場所</th><th>停車</th><th>発車</th><th>秒</th><th>フラグ</th></tr></thead>
        <tbody>${ss.map((s) => `
          <tr>
            <td>${s.stationId ? esc(nameOf(s.stationId)) : `<small>区間</small> ${esc(secName(s.sectionId))}`}</td>
            <td class="num">${fmtClock(s.startT, 1)}</td>
            <td class="num">${s.departT ? fmtClock(s.departT, 1) : '—'}</td>
            <td class="num">${s.sec.toFixed(1)}</td>
            <td class="num">${s.flag ? '■' : ''}</td>
          </tr>`).join('')}</tbody></table></div>

      <h3>軌跡から区間距離を実測</h3>
      <div class="row wrap">
        <select id="mA">${real.map((p) => `<option value="${esc(p.id)}">${esc(p.stationName)}</option>`).join('')}</select>
        →
        <select id="mB">${real.map((p, i) => `<option value="${esc(p.id)}" ${i === 1 ? 'selected' : ''}>${esc(p.stationName)}</option>`).join('')}</select>
        <button id="mGo" class="btn btn-small">計算</button>
      </div>
      <div id="mOut" class="muted"></div>

      <div class="row wrap gap">
        <button id="recalc" class="btn">現在の台帳と設定で再計算</button>
        <button id="delRun" class="btn btn-danger">この運転を削除</button>
      </div>
    </section>`;
  $('#back').addEventListener('click', () => renderRuns());
  $('#mGo').addEventListener('click', async () => {
    const a = real.find((p) => p.id === $('#mA').value);
    const b = real.find((p) => p.id === $('#mB').value);
    if (!a || !b || a === b) return;
    const r = ana.trackDistance(track, a.passT, b.passT, app.settings.stopKmh);
    const km = Math.round(r.meters) / 1000;
    const out = $('#mOut');
    out.innerHTML = `${esc(a.stationName)}→${esc(b.stationName)}：<b>${km.toFixed(3)} km</b>（測位 ${r.points} 点、台帳の差 ${Math.abs(b.km - a.km).toFixed(3)} km）`;
    // 台帳で隣り合う駅なら、後の駅の区間距離として登録できる
    const ia = app.stations.findIndex((s) => s.id === a.stationId);
    const ib = app.stations.findIndex((s) => s.id === b.stationId);
    if (ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1) {
      const later = app.stations[Math.max(ia, ib)];
      const btn = document.createElement('button');
      btn.className = 'btn btn-small';
      btn.textContent = `${later.name}の区間距離を ${km.toFixed(3)} km に設定`;
      btn.addEventListener('click', async () => {
        if (!confirm(`${later.name}のキロ程を「前の駅から ${km.toFixed(3)} km（GPSで実測）」に変更します。`)) return;
        const raw = await db.get('stations', later.id);
        await db.put('stations', { ...raw, kmMode: 'seg', kmValue: km, kmSource: 'gps' });
        await loadAll();
        btn.replaceWith('設定しました。');
      });
      out.append(document.createElement('br'), btn);
    }
  });
  $('#recalc').addEventListener('click', async () => {
    if (!confirm('保存された軌跡から通過・停車を計算し直します。')) return;
    await recompute(run);
    renderRunDetail(id);
  });
  $('#delRun').addEventListener('click', async () => {
    if (!confirm(`${run.trainNo} の記録（軌跡を含む）を削除します。元に戻せません。`)) return;
    await db.del('runs', id);
    for (const s of ['passages', 'stops', 'track']) await db.deleteByIndex(s, 'runId', id);
    renderRuns();
  });
}

/** 保存済みの軌跡から通過と停車を計算し直す。close なら中断中の運転を終了扱いにする */
async function recompute(run, { close = false } = {}) {
  const track = await loadTrack(run.id);
  const passages = new Map();
  const stops = new Map();
  const warnings = [];
  const eng = new RunEngine({
    run,
    stations: app.stations,
    settings: app.settings,
    on: {
      passage: (pa) => passages.set(pa.id, { ...pa }),
      stop: (s) => stops.set(s.id, { ...s }),
      warning: (w) => warnings.push(w),
    },
  });
  replay(eng, track, run.pauses);
  const endT = run.endTime ?? track[track.length - 1]?.t ?? run.startTime;
  if (!eng.arrived) eng.finish(endT);
  await db.deleteByIndex('passages', 'runId', run.id);
  await db.deleteByIndex('stops', 'runId', run.id);
  await db.putMany('passages', [...passages.values()]);
  await db.putMany('stops', [...stops.values()]);
  run.arrivalTime = eng.arrivalT;
  run.flagCount = [...passages.values()].filter((p) => p.stopFlag).length;
  run.warnings = [...new Set(warnings)];
  run.sectionStats = ana.runSectionStats([...passages.values()], track, app.settings.stopKmh);
  run.statsV = ana.STATS_VERSION;
  if (close) {
    run.status = 'done';
    run.endTime = endT;
    run.endReason = 'manual';
  }
  await db.put('runs', run);
}

// ====================================================================
// 駅台帳
// ====================================================================
function renderLedger() {
  const list = app.stations;
  const warns = [];
  list.forEach((s, i) => {
    if (i && s.km < list[i - 1].km) warns.push(`${s.name}：キロ程が前の駅より小さい`);
    if (!hasCoord(s)) warns.push(`${s.name}：座標が未入力`);
  });
  if (list.length && (list[0].type !== 'yard' || list[list.length - 1].type !== 'yard')) warns.push('先頭と末尾は停車場（自宅・9号館）にしてください');
  view.innerHTML = `
    <section class="page">
      <h2>駅台帳</h2>
      ${warns.length ? `<p class="warn">${warns.map(esc).join('<br>')}</p>` : ''}
      <div class="tblwrap"><table class="tbl">
        <thead><tr><th></th><th>駅名</th><th>種別</th><th>区間</th><th>キロ程</th><th>r</th><th></th></tr></thead>
        <tbody>${list.map((s, i) => `
          <tr>
            <td class="ord">
              <button class="mini" data-up="${i}" ${i ? '' : 'disabled'} aria-label="上へ">▲</button>
              <button class="mini" data-down="${i}" ${i < list.length - 1 ? '' : 'disabled'} aria-label="下へ">▼</button>
            </td>
            <td>${esc(s.name)}<br><small class="muted">${esc(s.id)}${s.note ? '・' + esc(s.note) : ''}</small></td>
            <td>${TYPE_LABEL[s.type]}</td>
            <td class="num">${s.segKm == null ? '' : s.segKm.toFixed(3) + (s.kmMode === 'seg' ? '*' : '')}</td>
            <td class="num">${s.km.toFixed(3)}${s.kmMode === 'cum' || s.segKm == null ? '*' : ''}</td>
            <td class="num">${s.r || `<span class="muted">${app.settings.radius}</span>`}</td>
            <td><button class="mini" data-edit="${esc(s.id)}">編集</button></td>
          </tr>`).join('')}</tbody></table></div>
      <p class="muted small">* は入力した値（区間距離か通算キロ程）。もう一方は計算値。</p>
      <div class="row wrap gap">
        <button id="addSt" class="btn">駅を追加</button>
        <button id="expLedger" class="btn">台帳を書き出し</button>
        <button id="impLedger" class="btn">台帳を読み込み</button>
      </div>
      <label class="row"><input type="checkbox" id="maskLedger"> 起点の座標を伏せて書き出す</label>
    </section>`;
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => editStation(b.dataset.edit)));
  $$('[data-up]').forEach((b) => b.addEventListener('click', () => moveStation(+b.dataset.up, -1)));
  $$('[data-down]').forEach((b) => b.addEventListener('click', () => moveStation(+b.dataset.down, 1)));
  $('#addSt').addEventListener('click', () => editStation(null));
  $('#expLedger').addEventListener('click', () =>
    download(ex.fileName('stations', 'json'), ex.ledgerJson(app.stations, $('#maskLedger').checked), 'application/json'));
  $('#impLedger').addEventListener('click', async () => {
    const text = await pickFile('.json,application/json');
    if (!text) return;
    try {
      const list = ex.parseLedger(text);
      if (!confirm(`${list.length} 駅を読み込み、今の台帳を置き換えます。`)) return;
      await db.clear('stations');
      await db.putMany('stations', list);
      await loadAll();
      renderLedger();
    } catch (e) {
      alert(`読み込めませんでした：${e.message}`);
    }
  });
}

async function moveStation(i, delta) {
  const list = app.stations.map((s) => ({ ...s }));
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const raws = await db.all('stations');
  const byId = new Map(raws.map((r) => [r.id, r]));
  await db.putMany('stations', list.map((s, k) => ({ ...byId.get(s.id), seq: k })));
  await loadAll();
  renderLedger();
}

async function editStation(id) {
  const raw = id ? await db.get('stations', id) : null;
  const list = app.stations;
  const idx = id ? list.findIndex((s) => s.id === id) : list.length;
  const prev = list[idx - 1] ?? null;
  const nextId = () => {
    let n = list.length + 1;
    while (list.some((s) => s.id === `S${String(n).padStart(2, '0')}`)) n++;
    return `S${String(n).padStart(2, '0')}`;
  };
  const s = raw ?? { id: nextId(), seq: list.length, name: '', type: 'signal', ixNo: '', lat: null, lon: null, kmMode: 'seg', kmValue: 0, kmSource: 'binran', r: null, note: '' };
  const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  const dlg = dialog(`
    <form method="dialog" class="form" id="stForm">
      <h3>${raw ? '駅を編集' : '駅を追加'}</h3>
      <label>駅ID <input name="id" value="${esc(s.id)}" ${raw ? 'readonly' : ''} required></label>
      <label>駅名 <input name="name" value="${esc(s.name)}" required></label>
      <label>種別 <select name="type">${opt(TYPE_LABEL, s.type)}</select></label>
      <label>交差点番号 <input name="ixNo" value="${esc(s.ixNo)}" inputmode="numeric"></label>
      <div class="row2">
        <label>緯度 <input name="lat" value="${s.lat ?? ''}" inputmode="decimal"></label>
        <label>経度 <input name="lon" value="${s.lon ?? ''}" inputmode="decimal"></label>
      </div>
      <button type="button" id="here" class="btn btn-small" ${app.cur ? 'disabled' : ''}>現在地の座標を入力</button>
      <span id="hereMsg" class="muted small"></span>
      <fieldset>
        <legend>キロ程</legend>
        <label class="inline"><input type="radio" name="kmMode" value="seg" ${s.kmMode === 'seg' ? 'checked' : ''}> 前の駅からの区間距離</label>
        <label class="inline"><input type="radio" name="kmMode" value="cum" ${s.kmMode === 'cum' ? 'checked' : ''}> 通算キロ程</label>
        <label>値（km） <input name="kmValue" value="${s.kmValue ?? 0}" inputmode="decimal"></label>
        <div id="kmPrev" class="muted small"></div>
        <label>出典 <select name="kmSource">${opt(SRC_LABEL, s.kmSource)}</select></label>
      </fieldset>
      <label>判定円の半径 r（m、空欄で既定値 ${app.settings.radius}） <input name="r" value="${s.r ?? ''}" inputmode="numeric"></label>
      <label>備考 <input name="note" value="${esc(s.note)}"></label>
      <div class="row gap">
        <button type="submit" class="btn" value="save">保存</button>
        <button type="button" class="btn" data-close>取消</button>
        ${raw ? '<button type="button" id="delSt" class="btn btn-danger">削除</button>' : ''}
      </div>
    </form>`);
  const f = $('#stForm', dlg);
  const preview = () => {
    const v = Number(f.kmValue.value) || 0;
    const mode = f.kmMode.value;
    const km = mode === 'seg' ? (prev?.km ?? 0) + v : v;
    $('#kmPrev', dlg).textContent = mode === 'seg'
      ? `通算 ${km.toFixed(3)} km（前の駅 ${prev ? prev.name + ' ' + prev.km.toFixed(3) : 'なし 0.000'} km ＋ ${v.toFixed(3)}）`
      : `前の駅から ${(km - (prev?.km ?? 0)).toFixed(3)} km`;
  };
  f.addEventListener('input', preview);
  preview();
  $('#here', dlg).addEventListener('click', async () => {
    $('#hereMsg', dlg).textContent = '測位中…';
    try {
      const p = await getOnce();
      f.lat.value = p.lat.toFixed(7);
      f.lon.value = p.lon.toFixed(7);
      $('#hereMsg', dlg).textContent = `精度 ±${Math.round(p.acc)} m`;
    } catch (e) {
      $('#hereMsg', dlg).textContent = `取得できません：${e.message}`;
    }
  });
  $('#delSt', dlg)?.addEventListener('click', async () => {
    if (!confirm(`${s.name} を台帳から削除します。`)) return;
    await db.del('stations', s.id);
    dlg.close();
    await loadAll();
    renderLedger();
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newId = f.id.value.trim();
    if (!raw && list.some((x) => x.id === newId)) return alert('その駅IDは使われています');
    const num = (v) => (String(v).trim() === '' || !isFinite(Number(v)) ? null : Number(v));
    await db.put('stations', {
      id: newId,
      seq: s.seq,
      name: f.name.value.trim(),
      type: f.type.value,
      ixNo: f.ixNo.value.trim(),
      lat: num(f.lat.value),
      lon: num(f.lon.value),
      kmMode: f.kmMode.value,
      kmValue: Number(f.kmValue.value) || 0,
      kmSource: f.kmSource.value,
      r: num(f.r.value),
      note: f.note.value.trim(),
    });
    dlg.close();
    await loadAll();
    renderLedger();
  });
}

// ====================================================================
// ダイヤ
// ====================================================================
async function renderDias() {
  const bands = app.settings.bands;
  view.innerHTML = `
    <section class="page">
      <h2>ダイヤ</h2>
      <div class="tblwrap"><table class="tbl">
        <thead><tr><th>名前</th><th>行先</th><th>時間帯</th><th>駅数</th><th></th></tr></thead>
        <tbody>${app.dias.map((d) => `
          <tr>
            <td>${esc(d.name)}</td><td>${DIR_LABEL[d.direction]}</td>
            <td class="num">${esc(d.start)}–${esc(d.end)}</td>
            <td class="num">${Object.keys(d.entries).length}</td>
            <td><button class="mini" data-edit="${esc(d.id)}">編集</button></td>
          </tr>`).join('')}</tbody></table></div>
      ${app.dias.length ? '' : '<p class="muted">ダイヤはまだありません。</p>'}
      <h3>過去の運転から作成</h3>
      <div class="form">
        <label>行先 <select id="dDir"><option value="down">下り</option><option value="up">上り</option></select></label>
        <label>時間帯 <select id="dBand">${bands.map((b, i) => `<option value="${i}">${esc(b.name)}（${b.start}–${b.end}）</option>`).join('')}</select></label>
        <p class="muted small">該当する時間帯に発車した、終了済みの運転の経過時間の中央値を使います（推定の通過は除外）。</p>
        <div class="row gap">
          <button id="dBuild" class="btn">作成</button>
          <button id="dEmpty" class="btn">空のダイヤを作成</button>
        </div>
        <div id="dMsg" class="muted"></div>
      </div>
    </section>`;
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => editDia(b.dataset.edit)));
  const newDia = (entries) => {
    const dir = $('#dDir').value;
    const b = bands[+$('#dBand').value];
    const base = `${b.name}${DIR_LABEL[dir]}`;
    let name = base;
    for (let k = 2; app.dias.some((d) => d.name === name); k++) name = `${base}${k}`;
    return { id: `d${Date.now()}`, name, direction: dir, start: b.start, end: b.end, entries };
  };
  $('#dBuild').addEventListener('click', async () => {
    const d = newDia({});
    const runs = await db.all('runs');
    const passagesByRun = groupBy(await db.all('passages'), 'runId');
    const r = ana.buildDia({ runs, passagesByRun, direction: d.direction, start: d.start, end: d.end });
    if (!r.runCount) return ($('#dMsg').textContent = '該当する運転がありません。');
    d.entries = r.entries;
    d.basedOn = r.runCount;
    await db.put('dias', d);
    await loadAll();
    editDia(d.id, `${r.runCount} 本の運転から作成しました。`);
  });
  $('#dEmpty').addEventListener('click', async () => {
    const d = newDia({});
    await db.put('dias', d);
    await loadAll();
    editDia(d.id);
  });
}

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    if (!m.has(x[key])) m.set(x[key], []);
    m.get(x[key]).push(x);
  }
  return m;
}

function editDia(id, msg = '') {
  const d = app.dias.find((x) => x.id === id);
  if (!d) return renderDias();
  const order = d.direction === 'down' ? app.stations : [...app.stations].reverse();
  view.innerHTML = `
    <section class="page">
      <button class="btn btn-small" id="back">← ダイヤ一覧</button>
      <h2>ダイヤの編集</h2>
      ${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
      <form class="form" id="diaForm">
        <label>名前 <input name="name" value="${esc(d.name)}" required></label>
        <label>行先 <select name="direction"><option value="down" ${d.direction === 'down' ? 'selected' : ''}>下り</option><option value="up" ${d.direction === 'up' ? 'selected' : ''}>上り</option></select></label>
        <div class="row2">
          <label>時間帯の開始 <input name="start" value="${esc(d.start)}" pattern="\\d{1,2}:\\d{2}"></label>
          <label>終了 <input name="end" value="${esc(d.end)}" pattern="\\d{1,2}:\\d{2}"></label>
        </div>
        <p class="muted small">各駅の予定通過時刻を、起点発車からの経過時間（分:秒）で入力。空欄の駅は予定なし。</p>
        <div class="tblwrap"><table class="tbl">
          <thead><tr><th>駅</th><th>キロ程</th><th>経過</th></tr></thead>
          <tbody>${order.map((s) => `
            <tr><td>${esc(s.name)}</td><td class="num">${s.km.toFixed(3)}</td>
            <td><input class="dur" data-sid="${esc(s.id)}" value="${d.entries[s.id] != null ? fmtDur(d.entries[s.id]) : ''}" inputmode="numeric" placeholder="m:ss"></td></tr>`).join('')}
          </tbody></table></div>
        <div class="row gap">
          <button type="submit" class="btn">保存</button>
          <button type="button" id="delDia" class="btn btn-danger">削除</button>
        </div>
      </form>
    </section>`;
  $('#back').addEventListener('click', () => renderDias());
  $('#delDia').addEventListener('click', async () => {
    if (!confirm(`ダイヤ「${d.name}」を削除します。`)) return;
    await db.del('dias', d.id);
    await loadAll();
    renderDias();
  });
  $('#diaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const entries = {};
    for (const inp of $$('input.dur', f)) {
      const v = parseDur(inp.value);
      if (inp.value.trim() && v == null) return alert(`${inp.value} は時間として読めません`);
      if (v != null) entries[inp.dataset.sid] = v;
    }
    await db.put('dias', { ...d, name: f.name.value.trim(), direction: f.direction.value, start: f.start.value, end: f.end.value, entries });
    await loadAll();
    editDia(d.id, '保存しました。');
  });
}

// ====================================================================
// 分析
// ====================================================================
async function renderAnalysis() {
  const sigs = app.stations.filter((s) => s.type === 'signal');
  const bands = app.settings.bands;
  const bandOpts = `<option value="">すべて</option>${bands.map((b, i) => `<option value="${i}">${esc(b.name)}</option>`).join('')}`;
  view.innerHTML = `
    <section class="page">
      <h2>信号の捕まりやすさ</h2>
      <p class="muted small">区間ごとに、次の信号で止まらずに通過できたか・捕まったかと、そのときの走行速度（停車中を除く平均）をまとめます。「目安」は運転台の時速計に緑の印で出す速度で、通過できたときの速度の中央値です。一度も通過できていない信号の手前は、急いでも待つだけなので遅めの値（下位25%）になります。</p>
      <div class="form">
        <div class="row2">
          <label>行先 <select id="sDir"><option value="down">下り</option><option value="up">上り</option></select></label>
          <label>時間帯 <select id="sBand">${bandOpts}</select></label>
        </div>
        <button id="sGo" class="btn">集計</button>
      </div>
      <div id="sOut"></div>

      <h2>信号周期の推定</h2>
      <p class="muted small">信号駅での発車時刻（青の開始の観測値）を周期の剰余で並べ、そろい具合 R（0〜1）が高い周期を候補として出します。R が雑音の目安を十分上回るものだけが意味のある候補です。</p>
      <div class="form">
        <label>信号駅 <select id="cSt">${sigs.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
        <div class="row2">
          <label>行先 <select id="cDir"><option value="">両方</option><option value="down">下り</option><option value="up">上り</option></select></label>
          <label>時間帯 <select id="cBand">${bandOpts}</select></label>
        </div>
        <div class="row2">
          <label>周期 最小（秒） <input id="cMin" value="60" inputmode="numeric"></label>
          <label>最大（秒） <input id="cMax" value="180" inputmode="numeric"></label>
        </div>
        <label>停車がこの秒数以上の発車だけ使う <input id="cMinStop" value="0" inputmode="numeric"></label>
        <button id="cGo" class="btn">推定</button>
      </div>
      <div id="cOut"></div>

      <h2>ダイヤグラム</h2>
      <div class="form">
        <div class="row2">
          <label>行先 <select id="gDir"><option value="down">下り</option><option value="up">上り</option></select></label>
          <label>直近の本数 <input id="gN" value="10" inputmode="numeric"></label>
        </div>
        <label>重ねるダイヤ <select id="gDia"><option value="">なし</option>${app.dias.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label>
        <button id="gGo" class="btn">描画</button>
      </div>
      <div id="gOut"></div>
    </section>`;
  $('#sGo').addEventListener('click', async () => {
    const dir = $('#sDir').value;
    const band = bands[$('#sBand').value];
    const runs = (await db.all('runs')).filter((r) => r.status === 'done' && !r.sim && r.direction === dir && (!band || inBand(r.startTime, band.start, band.end)));
    const statsByRun = await ensureStats(runs);
    const ids = new Set(runs.map((r) => r.id));
    const stops = (await db.all('stops')).filter((x) => ids.has(x.runId) && x.stationId);
    const pace = ana.buildPace({
      runs, statsByRun, passagesByRun: groupBy(await db.all('passages'), 'runId'),
      waits: stops.filter((x) => x.flag), direction: dir, startTime: Date.now(), bands: [], capKmh: app.settings.reqCapKmh,
    });
    const order = dir === 'down' ? app.stations : [...app.stations].reverse();
    const rows = [];
    for (let i = 1; i < order.length; i++) {
      const key = `${order[i - 1].id}>${order[i].id}`;
      const arr = runs.map((r) => statsByRun.get(r.id)?.[key]).filter((x) => x && x.moving != null);
      if (!arr.length) continue;
      const pass = arr.filter((x) => !x.caught).map((x) => x.moving);
      const caught = arr.filter((x) => x.caught).map((x) => x.moving);
      const w = median(stops.filter((x) => x.stationId === order[i].id && x.sec >= 3).map((x) => x.sec));
      const f = (v) => (v == null ? '—' : v.toFixed(1));
      rows.push(`<tr><td>${esc(order[i - 1].name)}→${esc(order[i].name)}</td><td class="num">${arr.length}</td>
        <td class="num">${order[i].type === 'signal' ? Math.round((caught.length / arr.length) * 100) + '%' : '—'}</td>
        <td class="num">${order[i].type === 'signal' && w != null ? Math.round(w) + 's' : '—'}</td>
        <td class="num">${f(median(pass))}</td><td class="num">${f(median(caught))}</td><td class="num">${f(pace.guide[key])}</td></tr>`);
    }
    $('#sOut').innerHTML = rows.length
      ? `<p class="muted small">${runs.length} 本の運転から集計（速度は km/h）</p>
        <div class="tblwrap"><table class="tbl"><thead><tr><th>区間</th><th>本数</th><th>捕まった</th><th>待ち</th><th>通過時</th><th>捕まり時</th><th>目安</th></tr></thead>
        <tbody>${rows.join('')}</tbody></table></div>`
      : '<p class="muted">該当する運転がありません。</p>';
  });
  $('#cGo').addEventListener('click', async () => {
    const sid = $('#cSt').value;
    const dir = $('#cDir').value;
    const band = bands[$('#cBand').value];
    const minStop = Number($('#cMinStop').value) || 0;
    const runs = new Map((await db.all('runs')).map((r) => [r.id, r]));
    const deps = (await db.all('stops')).filter((s) => {
      const r = runs.get(s.runId);
      return r && !r.sim && s.stationId === sid && s.departT && s.sec >= minStop && (!dir || r.direction === dir) && (!band || inBand(s.departT, band.start, band.end));
    });
    const res = ana.estimateCycle(deps.map((s) => s.departT), { min: Number($('#cMin').value) || 60, max: Number($('#cMax').value) || 180 });
    $('#cOut').innerHTML = res.n < 3
      ? `<p class="muted">発車の記録が ${res.n} 件しかありません（最低3件、実用には20件以上を推奨）。</p>`
      : `<p>発車 ${res.n} 件、雑音の目安 R ≈ ${res.noise.toFixed(2)}</p>
         <div class="tblwrap"><table class="tbl"><thead><tr><th>周期</th><th>R</th><th>青開始の位相</th></tr></thead>
         <tbody>${res.peaks.map((p) => `<tr><td class="num">${p.C.toFixed(1)} 秒</td><td class="num">${p.R.toFixed(2)}</td><td class="num">0時0分0秒＋${p.phase.toFixed(1)} 秒（周期ごと）</td></tr>`).join('')}</tbody></table></div>
         ${ana.cycleSvg(res.curve)}`;
  });
  $('#gGo').addEventListener('click', async () => {
    const dir = $('#gDir').value;
    const n = Number($('#gN').value) || 10;
    const runs = (await db.all('runs')).filter((r) => r.status === 'done' && r.direction === dir).sort((a, b) => a.startTime - b.startTime).slice(-n);
    const passagesByRun = groupBy(await db.all('passages'), 'runId');
    const dia = app.dias.find((d) => d.id === $('#gDia').value) ?? null;
    $('#gOut').innerHTML = runs.length || dia
      ? ana.diagramSvg({ stations: app.stations, runs, passagesByRun, dia }) + '<p class="muted small">縦軸：キロ程　横軸：起点発車からの経過時間　点線：ダイヤ　濃い線ほど新しい運転</p>'
      : '<p class="muted">該当する運転がありません。</p>';
  });
}

// ====================================================================
// データ・設定
// ====================================================================
function renderData() {
  const S = app.settings;
  const num = (k, label, unit) => `<label>${label}（${unit}） <input name="${k}" value="${S[k]}" inputmode="decimal"></label>`;
  view.innerHTML = `
    <section class="page">
      <h2>書き出し</h2>
      <label class="row"><input type="checkbox" id="mask"> 起点の座標を伏せる（台帳の起点座標を空にし、軌跡から起点 ${S.maskRadius} m 以内を除く）</label>
      <div class="row wrap gap">
        <button class="btn" data-exp="passages">passages.csv</button>
        <button class="btn" data-exp="stops">stops.csv</button>
        <button class="btn" data-exp="track">track.csv</button>
        <button class="btn" data-exp="ledger">台帳 JSON</button>
      </div>
      <h2>バックアップ</h2>
      <p class="muted small">すべてのデータ（台帳・記録・軌跡・ダイヤ・設定）を1つのJSONにします。復元すると今のデータは置き換わります。</p>
      <div class="row wrap gap">
        <button id="backup" class="btn">バックアップを書き出し</button>
        <button id="restore" class="btn btn-danger">バックアップから復元</button>
      </div>

      <h2>設定</h2>
      <form class="form" id="setForm">
        ${num('radius', '判定円の既定半径', 'm')}
        ${num('stopKmh', '停車とみなす速度', 'km/h 未満')}
        ${num('flagSec', '停車フラグの閾値', '秒以上')}
        ${num('arrivalSec', '到着とみなす停車', '秒以上')}
        ${num('reqCapKmh', '時速計の赤帯・目安速度の上限', 'km/h')}
        ${num('poorAcc', '判定に使わない測位', '精度 m 超')}
        ${num('hyst', '構外判定の余裕', 'm')}
        ${num('departFixes', '発車と確定する連続測位', '回')}
        ${num('mergeSec', '同じ駅への再進入をまとめる', '秒以内')}
        ${num('maskRadius', '起点を伏せるときに除く範囲', 'm')}
        ${num('chimeVol', '通過・到着の鈴の音量', '0〜100。0で鳴らさない')}
        <label>鈴の鳴らし方 <select name="chimeMethod">
          <option value="webaudio" ${S.chimeMethod !== 'file' ? 'selected' : ''}>Web Audio（標準）</option>
          <option value="file" ${S.chimeMethod === 'file' ? 'selected' : ''}>音声ファイル（Web Audio で鳴らないとき）</option>
        </select></label>
        <div class="row wrap gap">
          <button type="button" id="tryPass" class="btn btn-small">通過の音を試す</button>
          <button type="button" id="tryArr" class="btn btn-small">到着の音を試す</button>
          <button type="button" id="resetSnd" class="btn btn-small">鈴をリセット</button>
        </div>
        <span id="sndMsg" class="muted small">鈴が鳴らないときは「鈴をリセット」を押してください（音声を作り直して1回鳴らします）。</span>
        <fieldset>
          <legend>音の診断</legend>
          <p class="muted small">①〜③を順に押して、それぞれ音が聞こえたかを確かめてください。下に出る文は不具合の調査に使います。</p>
          <div class="row wrap gap">
            <button type="button" id="diag1" class="btn btn-small">① 単純な音（Web Audio）</button>
            <button type="button" id="diag2" class="btn btn-small">② 鈴（Web Audio）</button>
            <button type="button" id="diag3" class="btn btn-small">③ 鈴（音声ファイル）</button>
          </div>
          <pre id="sndDiag" class="diag"></pre>
        </fieldset>
        <label>表示 <select name="theme">
          <option value="night" ${S.theme === 'night' ? 'selected' : ''}>黒地（標準）</option>
          <option value="day" ${S.theme === 'day' ? 'selected' : ''}>白地（直射日光下）</option>
        </select></label>
        <label>時間帯（1行に「名前,開始,終了」）
          <textarea name="bands" rows="4">${S.bands.map((b) => `${b.name},${b.start},${b.end}`).join('\n')}</textarea></label>
        <button type="submit" class="btn">設定を保存</button>
        <span id="setMsg" class="ok"></span>
      </form>

      <h2>その他</h2>
      <div class="row wrap gap">
        <button id="sample" class="btn">サンプル台帳（仮の座標）を読み込む</button>
      </div>
      <p class="muted small">模擬走行：URL の末尾に <code>?sim=10</code>（10倍速）を付けて開くと、台帳の駅を結ぶ仮の走行で運転台を試せます。記録には「模擬」と付きます。<br>
      データはこの端末のブラウザ内（IndexedDB）にだけ保存され、外部へは送信しません。</p>
    </section>`;
  const mask = () => $('#mask').checked;
  $$('[data-exp]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.exp;
    if (k === 'passages') download(ex.fileName('passages', 'csv'), await ex.passagesCsv(), 'text/csv');
    if (k === 'stops') download(ex.fileName('stops', 'csv'), await ex.stopsCsv(), 'text/csv');
    if (k === 'track') download(ex.fileName('track', 'csv'), await ex.trackCsv(app.stations, mask(), S.maskRadius), 'text/csv');
    if (k === 'ledger') download(ex.fileName('stations', 'json'), ex.ledgerJson(app.stations, mask()), 'application/json');
  }));
  $('#backup').addEventListener('click', async () => download(ex.fileName('backup', 'json'), await ex.backupJson(), 'application/json'));
  $('#restore').addEventListener('click', async () => {
    const text = await pickFile('.json,application/json');
    if (!text) return;
    if (!confirm('今のデータをすべて置き換えて復元します。')) return;
    try {
      await ex.restoreJson(text);
      await loadAll();
      app.resumeRun = (await db.all('runs')).find((r) => r.status === 'running') || null;
      alert('復元しました。');
      renderData();
    } catch (e) {
      alert(`復元できませんでした：${e.message}`);
    }
  });
  $('#sample').addEventListener('click', async () => {
    if (app.stations.length && !confirm('今の台帳をサンプルで置き換えます。')) return;
    const text = await (await fetch('./sample-stations.json')).text();
    await db.clear('stations');
    await db.putMany('stations', ex.parseLedger(text));
    await loadAll();
    show('ledger');
  });
  const vol = () => Number($('#setForm').chimeVol.value) || 0;
  const how = () => $('#setForm').chimeMethod.value;
  for (const [id, kind] of [['#tryPass', 'pass'], ['#tryArr', 'arrive']]) {
    $(id).addEventListener('click', () => {
      unlockSound();
      chime(kind, vol(), how());
    });
  }
  const diagLog = (label, text) => {
    const el = $('#sndDiag');
    el.textContent += `${label} ${text}
`;
  };
  $('#diag1').addEventListener('click', async () => diagLog('①', await beepTest()));
  $('#diag2').addEventListener('click', async () => {
    unlockSound();
    diagLog('②', await chime('pass', vol(), 'webaudio'));
  });
  $('#diag3').addEventListener('click', async () => diagLog('③', await chime('pass', vol(), 'file')));
  $('#sndDiag').textContent = `${navigator.userAgent.match(/(Chrome|CriOS|Firefox|Version)\/[\d.]+/)?.[0] ?? ''} ${/Android [\d.]+/.exec(navigator.userAgent)?.[0] ?? ''}
`;
  $('#resetSnd').addEventListener('click', () => {
    resetSound();
    chime('pass', vol(), 'webaudio');
    setTimeout(() => {
      const st = soundState();
      $('#sndMsg').textContent = st === 'running' ? 'リセットしました（鳴らせる状態です）。' : `リセットしましたが、まだ鳴らせない状態です（${st}）。もう一度押してください。`;
    }, 300);
  });
  $('#setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = { theme: f.theme.value, chimeMethod: f.chimeMethod.value };
    for (const k of ['radius', 'stopKmh', 'flagSec', 'arrivalSec', 'reqCapKmh', 'poorAcc', 'hyst', 'departFixes', 'mergeSec', 'maskRadius', 'chimeVol']) {
      const v = Number(f[k].value);
      if (!isFinite(v) || v < 0) return alert(`${k} の値が不正です`);
      patch[k] = v;
    }
    const bands = f.bands.value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((a) => a.length === 3 && a[0]);
    if (!bands.length) return alert('時間帯を1つ以上入れてください');
    patch.bands = bands.map(([name, start, end]) => ({ name, start, end }));
    await saveSettings(patch);
    setSoundMethod(patch.chimeMethod);
    $('#setMsg').textContent = '保存しました。';
  });
}

init().catch((e) => {
  view.innerHTML = `<p class="warn">起動に失敗しました：${esc(e.message)}</p>`;
});
