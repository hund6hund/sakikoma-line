// CSV・JSON の書き出しと読み込み

import * as db from './db.js';
import { toCsv, fmtDateTime, WEEKDAYS, DIR_LABEL, TYPE_LABEL, dist, originStation, hasCoord } from './util.js';

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
export const fileName = (base, ext) => `sakikoma-${base}-${stamp()}.${ext}`;

/** 起点の座標を伏せた台帳 */
export function maskStations(stations) {
  const o = originStation(stations);
  return stations.map((s) => (o && s.id === o.id ? { ...s, lat: null, lon: null } : s));
}

const ledgerFields = (s) => ({
  id: s.id,
  seq: s.seq,
  name: s.name,
  type: s.type,
  ixNo: s.ixNo ?? '',
  lat: s.lat,
  lon: s.lon,
  kmMode: s.kmMode,
  kmValue: s.kmValue,
  km: s.km,
  kmSource: s.kmSource,
  r: s.r,
  note: s.note ?? '',
});

export function ledgerJson(stations, mask) {
  const list = (mask ? maskStations(stations) : stations).map(ledgerFields);
  return JSON.stringify({ app: 'sakikoma-line', kind: 'stations', version: 1, stations: list }, null, 2);
}

/**
 * 台帳JSONの読み込み。{stations:[...]} か配列を受け付ける。
 * km（通算）または segKm（前の駅からの区間距離）でもキロ程を指定できる。
 */
export function parseLedger(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.stations;
  if (!Array.isArray(arr)) throw new Error('stations の配列が見つかりません');
  const used = new Set();
  return arr.map((s, i) => {
    let id = String(s.id ?? '').trim() || `S${String(i + 1).padStart(2, '0')}`;
    while (used.has(id)) id += '_';
    used.add(id);
    let kmMode = s.kmMode === 'seg' ? 'seg' : 'cum';
    let kmValue = Number(s.kmValue);
    if (s.kmMode == null || !isFinite(kmValue)) {
      if (s.segKm != null) {
        kmMode = 'seg';
        kmValue = Number(s.segKm);
      } else {
        kmMode = 'cum';
        kmValue = Number(s.km ?? 0);
      }
    }
    const type = ['yard', 'signal', 'marker'].includes(s.type) ? s.type : 'signal';
    const num = (v) => (v === null || v === '' || v === undefined || !isFinite(Number(v)) ? null : Number(v));
    return {
      id,
      seq: i,
      name: String(s.name ?? id),
      type,
      ixNo: s.ixNo != null ? String(s.ixNo) : '',
      lat: num(s.lat),
      lon: num(s.lon),
      kmMode,
      kmValue: isFinite(kmValue) ? kmValue : 0,
      kmSource: ['binran', 'gsi', 'gps', 'other'].includes(s.kmSource) ? s.kmSource : 'other',
      r: num(s.r),
      note: String(s.note ?? ''),
    };
  });
}

// ---------------- CSV ----------------
export async function passagesCsv() {
  const runs = new Map((await db.all('runs')).map((r) => [r.id, r]));
  const rows = [['列車番号', '日付', '曜日', '行先', '駅ID', '駅名', '駅の種別', '交差点番号', 'キロ程', '通過時刻', '構内に入った時刻', '構内を出た時刻', '起点からの経過秒', '停車フラグ', '推定フラグ']];
  const ps = (await db.all('passages')).sort((a, b) => a.passT - b.passT);
  for (const p of ps) {
    const r = runs.get(p.runId);
    if (!r) continue;
    rows.push([
      r.trainNo,
      r.date,
      WEEKDAYS[new Date(r.startTime).getDay()],
      DIR_LABEL[r.direction],
      p.stationId,
      p.stationName,
      TYPE_LABEL[p.stationType] ?? p.stationType,
      p.ixNo,
      p.km?.toFixed(3),
      fmtDateTime(p.passT, 1),
      fmtDateTime(p.enterT, 1),
      fmtDateTime(p.exitT, 1),
      ((p.passT - r.startTime) / 1000).toFixed(1),
      p.stopFlag ? 1 : 0,
      p.estimated ? 1 : 0,
    ]);
  }
  return toCsv(rows);
}

export async function stopsCsv() {
  const runs = new Map((await db.all('runs')).map((r) => [r.id, r]));
  const rows = [['列車番号', '駅ID', '区間ID', '停車開始時刻', '発車時刻', '停車秒', '停車フラグ']];
  const ss = (await db.all('stops')).sort((a, b) => a.startT - b.startT);
  for (const s of ss) {
    const r = runs.get(s.runId);
    if (!r) continue;
    rows.push([r.trainNo, s.stationId ?? '', s.sectionId ?? '', fmtDateTime(s.startT, 1), fmtDateTime(s.departT, 1), s.sec, s.flag ? 1 : 0]);
  }
  return toCsv(rows);
}

export async function trackCsv(stations, mask, maskRadius) {
  const runs = new Map((await db.all('runs')).map((r) => [r.id, r]));
  const o = originStation(stations);
  const hide = mask && hasCoord(o);
  const rows = [['列車番号', '時刻', '緯度', '経度', '精度', '速度(km/h)', '精度不良']];
  const ts = (await db.all('track')).sort((a, b) => a.t - b.t);
  for (const p of ts) {
    const r = runs.get(p.runId);
    if (!r) continue;
    if (hide && dist(p, o) <= maskRadius) continue;
    rows.push([r.trainNo, fmtDateTime(p.t, 1), p.lat.toFixed(7), p.lon.toFixed(7), p.acc?.toFixed(1), (p.speed * 3.6).toFixed(1), p.poor ? 1 : 0]);
  }
  return toCsv(rows);
}

// ---------------- バックアップ ----------------
export async function backupJson() {
  const out = { app: 'sakikoma-line', kind: 'backup', version: 1, exportedAt: new Date().toISOString() };
  for (const name of db.STORES) out[name] = await db.all(name);
  return JSON.stringify(out);
}

export async function restoreJson(text) {
  const data = JSON.parse(text);
  if (!['sakikoma-line', 'sakiba-line'].includes(data.app) || data.kind !== 'backup') throw new Error('崎駒線のバックアップではありません');
  for (const name of db.STORES) {
    await db.clear(name);
    if (Array.isArray(data[name])) await db.putMany(name, data[name]);
  }
}
