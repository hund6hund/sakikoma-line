// 共通の計算・書式ユーティリティ

export const EARTH_R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export const M_PER_DEG = rad(1) * EARTH_R;

/** 2点間の距離（m、ハーバーサイン） */
export function dist(a, b) {
  const dlat = rad(b.lat - a.lat);
  const dlon = rad(b.lon - a.lon);
  const s =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** origin を原点とする局所平面座標（m） */
export function toXY(origin, p) {
  return {
    x: (p.lon - origin.lon) * M_PER_DEG * Math.cos(rad(origin.lat)),
    y: (p.lat - origin.lat) * M_PER_DEG,
  };
}

/**
 * 点 c から線分 ab へ引いた垂線の足。
 * u: 線分上の位置（0=a, 1=b。範囲外もそのまま返す）、d: c から（クランプ後の）足までの距離
 */
export function projectOnSegment(c, a, b) {
  const A = toXY(c, a);
  const B = toXY(c, b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const L2 = dx * dx + dy * dy;
  const u = L2 > 0 ? -(A.x * dx + A.y * dy) / L2 : 0;
  const uc = Math.max(0, Math.min(1, u));
  return { u, uc, d: Math.hypot(A.x + uc * dx, A.y + uc * dy) };
}

// ---- 書式 ----
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const WEEKDAYS = '日月火水木金土';

export function fmtDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtClock(t, dec = 0) {
  if (t == null) return '';
  const d = new Date(t);
  let s = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (dec > 0) s += '.' + pad(Math.floor(d.getMilliseconds() / 10 ** (3 - dec)), dec);
  return s;
}

export function fmtDateTime(t, dec = 1) {
  return t == null ? '' : `${fmtDate(t)} ${fmtClock(t, dec)}`;
}

/** 秒 → m:ss / h:mm:ss */
export function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  const neg = sec < 0;
  sec = Math.abs(Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (neg ? '-' : '') + (h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`);
}

/** 定時差の表示（+は遅れ、-は早着） */
export function fmtSigned(sec) {
  if (sec == null || !isFinite(sec)) return '';
  const r = Math.round(sec);
  return (r > 0 ? '+' : r < 0 ? '-' : '±') + fmtDur(Math.abs(r));
}

/** "m:ss" / "h:mm:ss" / 秒数 → 秒。空や不正なら null */
export function parseDur(str) {
  str = String(str ?? '').trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  const parts = str.split(':').map(Number);
  if (parts.some((n) => !isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** 当日0時からの秒（ローカル時刻） */
export function clockSec(t) {
  const d = new Date(t);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}

/** "HH:MM" の時間帯 [start, end) に t が入るか（日をまたぐ帯にも対応） */
export function inBand(t, start, end) {
  const toS = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60;
  };
  const c = clockSec(t);
  const a = toS(start);
  const b = toS(end);
  return a <= b ? c >= a && c < b : c >= a || c < b;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 行の配列 → CSV文字列（Excel向けにBOM付き） */
export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function median(arr) {
  const a = arr.filter((x) => isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---- 駅台帳 ----
export const TYPE_LABEL = { yard: '停車場', signal: '信号駅', marker: '標識' };
export const SRC_LABEL = { binran: '便覧', gsi: '地理院地図で計測', gps: 'GPSで実測', other: 'その他' };
export const DIR_LABEL = { down: '下り', up: '上り' };

/**
 * 台帳（seq順）からキロ程を通算する。
 * kmMode: 'cum' = kmValue が通算キロ程、'seg' = kmValue が前の駅からの区間距離
 */
export function computeKm(stations) {
  const list = [...stations].sort((a, b) => a.seq - b.seq);
  let prev = null;
  return list.map((st) => {
    const v = Number(st.kmValue) || 0;
    const km = st.kmMode === 'seg' ? (prev ? prev.km : 0) + v : v;
    const out = {
      ...st,
      km: Math.round(km * 1000) / 1000,
      segKm: prev ? Math.round((km - prev.km) * 1000) / 1000 : null,
    };
    prev = out;
    return out;
  });
}

export const hasCoord = (st) => isFinite(st?.lat) && isFinite(st?.lon) && st.lat !== null && st.lon !== null;

/** 起点（自宅）＝キロ程最小の停車場 */
export function originStation(stations) {
  const yards = stations.filter((s) => s.type === 'yard');
  return (yards.length ? yards : stations).reduce((a, b) => (!a || b.km < a.km ? b : a), null);
}

export const DEFAULT_SETTINGS = {
  radius: 40, // 判定円の既定半径 m
  hyst: 10, // 構外判定のヒステリシス m
  mergeSec: 30, // 出た直後に同じ駅へ再進入したら同一の通過として扱う秒数
  poorAcc: 50, // これより精度が悪い測位は判定に使わない m
  stopKmh: 3, // 停車とみなす速度 km/h
  departFixes: 2, // 発車と確定する連続測位数
  flagSec: 15, // 停車フラグの閾値 秒
  arrivalSec: 20, // 到着とみなす停車秒数（試走により30→20）
  chimeVol: 60, // 通過・到着の鈴の音量 0〜100（0で鳴らさない）
  chimeMethod: 'webaudio', // 鈴の鳴らし方 webaudio | file（Web Audio で鳴らない端末向け）
  reqCapKmh: 40, // 必要時速の上限 km/h
  maskRadius: 300, // 起点を伏せるとき軌跡を除く半径 m
  theme: 'night', // night | day
  bands: [
    { name: '朝', start: '05:00', end: '11:00' },
    { name: '昼', start: '11:00', end: '16:00' },
    { name: '夕', start: '16:00', end: '20:00' },
    { name: '夜', start: '20:00', end: '05:00' },
  ],
};
