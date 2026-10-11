// 位置の取得。実機では Geolocation の watchPosition、URL に ?sim=倍率 を付けると
// 台帳の駅を結ぶ模擬走行を流す（画面確認用。記録は通常どおり保存される）。

import { dist } from './util.js';

const params = new URLSearchParams(location.search);
export const SIM = params.has('sim') ? Number(params.get('sim')) || 1 : 0;

/** アプリ内の時計。模擬走行のときだけ倍速で進む */
export const clock = {
  mult: SIM || 1,
  base: SIM ? Date.now() : null,
  realBase: SIM ? performance.now() : null,
  now() {
    return this.base == null ? Date.now() : this.base + (performance.now() - this.realBase) * this.mult;
  },
};

export class GeoLocator {
  start(onFix, onError) {
    this.last = 0;
    this.id = navigator.geolocation.watchPosition(
      (pos) => {
        const t = pos.timestamp || Date.now();
        if (t <= this.last) return;
        this.last = t;
        const c = pos.coords;
        onFix({ t, lat: c.latitude, lon: c.longitude, acc: c.accuracy, speedRaw: c.speed ?? null });
      },
      (err) => onError?.(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  stop() {
    if (this.id != null) navigator.geolocation.clearWatch(this.id);
    this.id = null;
  }
}

export class SimLocator {
  constructor(route) {
    this.route = route;
  }

  start(onFix) {
    const plan = this._plan();
    let i = 0;
    this.timer = setInterval(() => {
      if (i < plan.length) onFix({ ...plan[i++], t: clock.now() });
    }, 1000 / clock.mult);
  }

  stop() {
    clearInterval(this.timer);
  }

  _plan() {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const out = [];
    const push = (lat, lon, v, acc = 5 + rnd() * 8) => {
      const dy = (rnd() - 0.5) * 6;
      const dx = (rnd() - 0.5) * 6;
      out.push({
        lat: lat + dy / 111195,
        lon: lon + dx / (111195 * Math.cos((lat * Math.PI) / 180)),
        acc,
        speedRaw: v,
      });
    };
    const r = this.route;
    if (r.length < 2) return out;
    for (let k = 0; k < 5; k++) push(r[0].lat, r[0].lon, 0);
    for (let s = 0; s < r.length - 1; s++) {
      const a = r[s];
      const b = r[s + 1];
      const v = 6 + rnd() * 5;
      const n = Math.max(1, Math.round(dist(a, b) / v));
      for (let j = 1; j <= n; j++) {
        const f = j / n;
        push(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f, v + (rnd() - 0.5) * 2);
      }
      if (b.type === 'signal' && rnd() < 0.6) {
        const w = Math.round(5 + rnd() * 50);
        for (let k = 0; k < w; k++) push(b.lat, b.lon, rnd() * 0.4);
      }
    }
    const e = r[r.length - 1];
    for (let k = 0; k < 60; k++) push(e.lat, e.lon, rnd() * 0.3);
    return out;
  }
}

/** 一回だけ現在地を取る（台帳の座標入力・行先の提案用） */
export function getOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('位置情報が使えません'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  });
}
