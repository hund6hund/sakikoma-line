// ダイヤの作成、信号周期の推定、ダイヤグラム、軌跡からの距離計算

import { dist, median, inBand, clockSec, esc, fmtDur } from './util.js';

/** 運転の通過記録（推定を除く）を route 順に並べ、区間の所要時間と平均時速を出す */
export function sections(passages) {
  const ps = passages.slice().sort((a, b) => a.order - b.order || a.passT - b.passT);
  const out = [];
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1];
    const b = ps[i];
    const sec = (b.passT - a.passT) / 1000;
    const km = Math.abs(b.km - a.km);
    out.push({ from: a, to: b, sec, km, kmh: sec > 0 ? (km / sec) * 3600 : null, estimated: a.estimated || b.estimated });
  }
  return out;
}

/** 過去の運転から駅ごとの経過時間（中央値）でダイヤを作る */
export function buildDia({ runs, passagesByRun, direction, start, end }) {
  const used = runs.filter(
    (r) => r.status === 'done' && r.direction === direction && inBand(r.startTime, start, end),
  );
  const samples = new Map();
  for (const r of used) {
    for (const p of passagesByRun.get(r.id) || []) {
      if (p.estimated) continue;
      const e = (p.passT - r.startTime) / 1000;
      if (!samples.has(p.stationId)) samples.set(p.stationId, []);
      samples.get(p.stationId).push(e);
    }
  }
  const entries = {};
  const counts = {};
  for (const [id, arr] of samples) {
    entries[id] = Math.round(median(arr));
    counts[id] = arr.length;
  }
  return { entries, counts, runCount: used.length };
}

/** 運転開始の時刻と行先から該当するダイヤを選ぶ */
export function pickDia(dias, direction, t) {
  return dias.find((d) => d.direction === direction && inBand(t, d.start, d.end)) || null;
}

/**
 * 発車時刻（青の開始の観測値）を周期 C の剰余で並べ、位相のそろい具合
 * （平均合成ベクトル長 R）が大きい C を周期の候補とする。
 */
export function estimateCycle(times, { min = 60, max = 200, step = 0.5 } = {}) {
  const xs = times.map(clockSec);
  const n = xs.length;
  const curve = [];
  for (let C = min; C <= max + 1e-9; C += step) {
    let sx = 0;
    let sy = 0;
    for (const x of xs) {
      const th = (2 * Math.PI * (x % C)) / C;
      sx += Math.cos(th);
      sy += Math.sin(th);
    }
    const R = n ? Math.hypot(sx, sy) / n : 0;
    let phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * C;
    if (phase < 0) phase += C;
    curve.push({ C: Math.round(C * 10) / 10, R, phase });
  }
  const peaks = curve
    .filter((p, i) => i > 0 && i < curve.length - 1 && p.R >= curve[i - 1].R && p.R >= curve[i + 1].R)
    .sort((a, b) => b.R - a.R)
    .slice(0, 5);
  return { n, curve, peaks, noise: n ? 1 / Math.sqrt(n) : 0 };
}

export function cycleSvg(curve, w = 600, h = 160) {
  if (!curve.length) return '';
  const minC = curve[0].C;
  const maxC = curve[curve.length - 1].C;
  const X = (c) => 30 + ((c - minC) / (maxC - minC || 1)) * (w - 40);
  const Y = (r) => h - 20 - r * (h - 30);
  const d = curve.map((p, i) => `${i ? 'L' : 'M'}${X(p.C).toFixed(1)},${Y(p.R).toFixed(1)}`).join('');
  let ticks = '';
  for (let c = Math.ceil(minC / 20) * 20; c <= maxC; c += 20) {
    ticks += `<line x1="${X(c)}" x2="${X(c)}" y1="${h - 20}" y2="10" class="grid"/><text x="${X(c)}" y="${h - 5}" class="ax" text-anchor="middle">${c}</text>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="周期ごとの位相のそろい具合">
    ${ticks}<text x="4" y="14" class="ax">R</text><text x="${w - 4}" y="${h - 5}" class="ax" text-anchor="end">秒</text>
    <path d="${d}" class="line"/></svg>`;
}

/** ダイヤグラム（縦軸キロ程、横軸は起点発車からの経過時間） */
export function diagramSvg({ stations, runs, passagesByRun, dia }) {
  const w = 640;
  const h = 420;
  const L = 96;
  const T = 12;
  const B = 28;
  const Rm = 10;
  const kms = stations.map((s) => s.km);
  const maxKm = Math.max(0.001, ...kms);
  let maxSec = 60;
  const lines = [];
  for (const r of runs) {
    const ps = (passagesByRun.get(r.id) || []).slice().sort((a, b) => a.passT - b.passT);
    if (!ps.length) continue;
    const pts = ps.map((p) => ({ x: (p.passT - r.startTime) / 1000, km: p.km }));
    maxSec = Math.max(maxSec, ...pts.map((p) => p.x));
    lines.push({ r, pts });
  }
  let diaPts = null;
  if (dia) {
    diaPts = stations
      .filter((s) => dia.entries[s.id] != null)
      .map((s) => ({ x: dia.entries[s.id], km: s.km }))
      .sort((a, b) => a.x - b.x);
    maxSec = Math.max(maxSec, ...diaPts.map((p) => p.x));
  }
  maxSec = Math.ceil(maxSec / 300) * 300;
  const X = (s) => L + (s / maxSec) * (w - L - Rm);
  const Y = (km) => T + (km / maxKm) * (h - T - B);
  let g = '';
  for (const s of stations) {
    g += `<line x1="${L}" x2="${w - Rm}" y1="${Y(s.km)}" y2="${Y(s.km)}" class="grid"/>`;
    g += `<text x="${L - 4}" y="${Y(s.km) + 4}" class="ax" text-anchor="end">${esc(s.name.slice(0, 7))}</text>`;
  }
  for (let s = 0; s <= maxSec; s += 300) {
    g += `<line x1="${X(s)}" x2="${X(s)}" y1="${T}" y2="${h - B}" class="grid"/>`;
    g += `<text x="${X(s)}" y="${h - 8}" class="ax" text-anchor="middle">${fmtDur(s)}</text>`;
  }
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.km).toFixed(1)}`).join('');
  const n = lines.length;
  lines.forEach((ln, i) => {
    const op = n > 1 ? 0.35 + (0.65 * i) / (n - 1) : 1;
    g += `<path d="${path(ln.pts)}" class="run" style="opacity:${op.toFixed(2)}"><title>${esc(ln.r.trainNo)}</title></path>`;
  });
  if (diaPts?.length) g += `<path d="${path(diaPts)}" class="dia"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="ダイヤグラム">${g}</svg>`;
}

/** 軌跡上で時刻 tA から tB までに走った距離（m）。精度不良の点と停車中の揺らぎは除く */
export function trackDistance(track, tA, tB, stopKmh = 3) {
  const [a, b] = tA <= tB ? [tA, tB] : [tB, tA];
  const pts = track.filter((p) => !p.poor && p.t >= a && p.t <= b).sort((x, y) => x.t - y.t);
  let d = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].speed * 3.6 >= stopKmh) d += dist(pts[i - 1], pts[i]);
  return { meters: d, points: pts.length };
}

/**
 * 時刻 t0〜t1 の最高時速（km/h）。精度不良の点は除き、
 * GPSの速度の一瞬の跳ねを拾わないよう前後3点の中央値で均してから最大をとる。
 */
export function maxSpeed(track, t0, t1) {
  if (t0 == null || t1 == null) return null;
  const pts = track.filter((p) => !p.poor && isFinite(p.speed)).sort((a, b) => a.t - b.t);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].t < t0 || pts[i].t > t1) continue;
    const w = [pts[i - 1], pts[i], pts[i + 1]].filter(Boolean).map((p) => p.speed).sort((a, b) => a - b);
    const v = w[(w.length - 1) >> 1] * 3.6;
    if (best == null || v > best) best = v;
  }
  return best;
}

// ---------------- 区間の目安速度と到着予想 ----------------

export const STATS_VERSION = 1;

function quantile(arr, q) {
  const a = arr.filter((x) => isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  return a[lo] + (a[Math.min(a.length - 1, lo + 1)] - a[lo]) * (i - lo);
}

/**
 * 1本の運転の区間ごとの集計。キーは「前の駅ID>次の駅ID」（進行方向順）。
 *   moving : 区間を走っているあいだ（低速でないとき）の平均時速
 *   caught : 次の駅が信号駅で、そこで止まったか
 */
export function runSectionStats(passages, track, stopKmh) {
  const ps = passages.slice().sort((a, b) => a.order - b.order || a.passT - b.passT);
  const pts = track.filter((p) => !p.poor && isFinite(p.speed)).sort((a, b) => a.t - b.t);
  const out = {};
  let j = 0;
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1];
    const b = ps[i];
    if (b.order !== a.order + 1) continue;
    while (j < pts.length && pts[j].t < a.passT) j++;
    let sum = 0;
    let n = 0;
    for (let k = j; k < pts.length && pts[k].t <= b.passT; k++) {
      const v = pts[k].speed * 3.6;
      if (v >= stopKmh) {
        sum += v;
        n++;
      }
    }
    out[`${a.stationId}>${b.stationId}`] = {
      moving: n ? sum / n : null,
      signal: b.stationType === 'signal',
      caught: b.stationType === 'signal' && (b.stopSec || 0) >= 3,
    };
  }
  return out;
}

/**
 * 過去の運転から、走行中に使う「いつものペース」をまとめる。
 * 同じ行先で、今の時間帯に3本以上あればその時間帯だけ、なければ同じ行先すべてを使う。
 *   guide  : 区間の目安速度。次が信号なら、止まらずに通過できたときの走行速度の中央値。
 *            一度も通過できていない（いつも捕まる）信号の手前は、急いでも待つだけなので下位25%の速度。
 *   rem    : 駅を通過してから到着までの時間（秒）の中央値
 *   leg    : 駅から次の駅までの時間（秒）の中央値
 *   buffer : 信号1つ分の余裕（停車フラグの立った信号停車の中央値）
 */
export function buildPace({ runs, statsByRun, passagesByRun, waits, direction, startTime, bands, capKmh }) {
  const same = runs.filter((r) => r.status === 'done' && !r.sim && r.direction === direction && r.arrivalTime);
  const band = bands.find((b) => inBand(startTime, b.start, b.end));
  const inB = band ? same.filter((r) => inBand(r.startTime, band.start, band.end)) : [];
  const use = inB.length >= 3 ? inB : same;
  const ids = new Set(use.map((r) => r.id));

  const bySec = new Map();
  for (const r of use) {
    for (const [k, s] of Object.entries(statsByRun.get(r.id) || {})) {
      if (s.moving == null) continue;
      if (!bySec.has(k)) bySec.set(k, []);
      bySec.get(k).push(s);
    }
  }
  const guide = {};
  for (const [k, arr] of bySec) {
    if (arr.length < 2) continue;
    const pass = arr.filter((s) => !s.caught).map((s) => s.moving);
    const g = arr[0].signal && !pass.length ? quantile(arr.map((s) => s.moving), 0.25) : median(arr[0].signal ? pass : arr.map((s) => s.moving));
    guide[k] = Math.max(10, Math.min(capKmh, g));
  }

  const remS = new Map();
  const legS = new Map();
  const push = (m, k, v) => (m.has(k) ? m.get(k).push(v) : m.set(k, [v]));
  for (const r of use) {
    const ps = (passagesByRun.get(r.id) || []).filter((p) => !p.estimated).sort((a, b) => a.order - b.order);
    ps.forEach((p, i) => {
      push(remS, p.stationId, (r.arrivalTime - p.passT) / 1000);
      const q = ps[i + 1];
      if (q && q.order === p.order + 1) push(legS, p.stationId, (q.passT - p.passT) / 1000);
    });
  }
  const rem = {};
  const leg = {};
  for (const [k, v] of remS) rem[k] = median(v);
  for (const [k, v] of legS) leg[k] = median(v);

  const w = median(waits.filter((x) => ids.has(x.runId)).map((x) => x.sec));
  const buffer = Math.max(20, Math.min(90, w ?? 40));
  return { guide, rem, leg, buffer, runCount: use.length, bandName: inB.length >= 3 ? band.name : null };
}

/** 到着予想時刻（ms）。最後に通過した駅からいつもの残り時間を足し、今の区間で遅れていればその分を足す */
export function estimateArrival(pace, { lastPassage, originId, now, dia, terminalId }) {
  const remOf = (id) => pace?.rem[id] ?? (dia?.entries[terminalId] != null && dia.entries[id] != null ? dia.entries[terminalId] - dia.entries[id] : null);
  const legOf = (id) => pace?.leg[id] ?? null;
  const buf = (pace?.buffer ?? 40) * 1000;
  if (!lastPassage) {
    const r = remOf(originId);
    return r == null ? null : now + r * 1000 + buf;
  }
  const r = remOf(lastPassage.stationId);
  if (r == null) return null;
  let t = lastPassage.passT + r * 1000;
  const l = legOf(lastPassage.stationId);
  if (l != null) {
    const over = now - (lastPassage.passT + l * 1000);
    if (over > 0) t += over;
  }
  return t + buf;
}
