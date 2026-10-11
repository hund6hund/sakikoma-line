// 運転の判定エンジン。
// 測位を1点ずつ feed() すると、通過・停車・到着を判定してコールバックで知らせる。
// 入力（生の測位）だけで結果が決まるので、保存済みの軌跡を流し直せば
// 中断からの再開や台帳修正後の再計算ができる。

import { dist, projectOnSegment, hasCoord } from './util.js';

export class RunEngine {
  /**
   * @param {object} o
   * @param {object} o.run       運転（id, direction, startTime）
   * @param {object[]} o.stations computeKm 済みの台帳
   * @param {object} o.settings
   * @param {object} o.on        { passage(pa), stop(st), arrive(t), warning(msg) }
   */
  constructor({ run, stations, settings, on = {} }) {
    this.run = run;
    this.s = settings;
    this.on = on;
    const asc = stations.filter(hasCoord).sort((a, b) => a.km - b.km);
    this.route = run.direction === 'down' ? asc : asc.reverse();
    this.orderOf = new Map(this.route.map((st, i) => [st.id, i]));
    this.terminal = this.route[this.route.length - 1];

    this.pts = []; // 判定に使った（精度の良い）測位
    this.visits = new Map(); // stationId -> 構内にいるあいだの状態
    this.passages = [];
    this.meta = new WeakMap(); // passage -> 内部情報（保存しない）
    this.passCount = new Map();
    this.lastOrder = -1; // 通過済みの最も先の駅（route上の添字）
    this.lastPassage = null;
    this.stop = null; // 進行中の低速状態
    this.stops = [];
    this.departed = null; // 起点の判定円を出たか（最初の測位で決まる）
    this.termFirstStopT = null;
    this.arrived = false;
    this.arrivalT = null;
    this.lastFix = null;
    this.warnings = [];
  }

  radius(st) {
    return Number(st.r) > 0 ? Number(st.r) : this.s.radius;
  }

  /** 生の測位 {t, lat, lon, acc, speedRaw} を処理し、保存用の点を返す */
  feed(raw) {
    const prev = this.pts[this.pts.length - 1];
    let speed = raw.speedRaw;
    let speedSrc = 'gps';
    if (speed == null || !isFinite(speed) || speed < 0) {
      speed = prev && raw.t > prev.t ? dist(prev, raw) / ((raw.t - prev.t) / 1000) : 0;
      speedSrc = 'calc';
    }
    const poor = !(raw.acc <= this.s.poorAcc);
    const p = { t: raw.t, lat: raw.lat, lon: raw.lon, acc: raw.acc, speedRaw: raw.speedRaw ?? null, speed, speedSrc, poor };
    this.lastFix = p;
    if (poor || this.arrived) return p;

    const low = speed * 3.6 < this.s.stopKmh;
    p.i = this.pts.length;
    // 停車中のGPSの揺らぎを走行距離に積まない
    p.odo = prev ? prev.odo + (low ? 0 : dist(prev, p)) : 0;
    this.pts.push(p);

    if (this.departed === null) {
      const o = this.route[0];
      this.departed = !(o && dist(p, o) <= this.radius(o));
    }
    this._stations(p);
    this._stopLogic(p, low);
    return p;
  }

  // ---------------- 通過の判定 ----------------
  _stations(p) {
    for (const st of this.route) {
      const d = dist(p, st);
      const r = this.radius(st);
      let v = this.visits.get(st.id);
      if (!v) {
        if (d > r) continue;
        if (!this._reopen(st, p)) {
          v = { st, enterIdx: p.i, enterT: p.t, minD: d, minIdx: p.i, lastInIdx: p.i, stopFlag: false, stopSec: 0 };
          this.visits.set(st.id, v);
        }
        continue;
      }
      if (d < v.minD) {
        v.minD = d;
        v.minIdx = p.i;
      }
      if (d <= r) v.lastInIdx = p.i;
      else if (d > r + this.s.hyst) {
        v.exitIdx = v.lastInIdx + 1;
        v.exitT = this.pts[v.exitIdx].t;
        this.visits.delete(st.id);
        this._finalize(v);
      }
    }
  }

  /** 出てすぐ同じ駅に戻った（境界付近の揺らぎ）なら、直前の通過を取り消して構内に戻す */
  _reopen(st, p) {
    const pa = this.passages[this.passages.length - 1];
    if (!pa || pa.stationId !== st.id || pa.estimated) return false;
    const m = this.meta.get(pa);
    if (!m?.visit || pa.exitT == null || p.t - pa.exitT > this.s.mergeSec * 1000) return false;
    this.passages.pop();
    this.passCount.set(st.id, this.passCount.get(st.id) - 1);
    this.lastOrder = m.prevOrder;
    this.lastPassage = m.prevPassage;
    const v = m.visit;
    delete v.exitIdx;
    delete v.exitT;
    v.lastInIdx = p.i;
    const d = dist(p, st);
    if (d < v.minD) {
      v.minD = d;
      v.minIdx = p.i;
    }
    this.visits.set(st.id, v);
    return true;
  }

  /** 最接近点の前後の線分に駅の中心から垂線を下ろし、その足の時刻を通過時刻とする */
  _interp(k, st) {
    const pts = this.pts;
    let best = { t: pts[k].t, d: dist(pts[k], st) };
    for (const [a, b] of [[k - 1, k], [k, k + 1]]) {
      if (a < 0 || b >= pts.length) continue;
      const pr = projectOnSegment(st, pts[a], pts[b]);
      if (pr.u >= 0 && pr.u <= 1 && pr.d < best.d) {
        best = { t: pts[a].t + pr.u * (pts[b].t - pts[a].t), d: pr.d };
      }
    }
    return best;
  }

  _snapshot(st) {
    return {
      runId: this.run.id,
      stationId: st.id,
      stationName: st.name,
      stationType: st.type,
      ixNo: st.ixNo ?? '',
      km: st.km,
      order: this.orderOf.get(st.id),
    };
  }

  _nextId(st) {
    const n = this.passCount.get(st.id) || 0;
    this.passCount.set(st.id, n + 1);
    return `${this.run.id}|${st.id}|${n}`;
  }

  _finalize(v) {
    const st = v.st;
    const order = this.orderOf.get(st.id);
    if (this.lastOrder >= 0 && order > this.lastOrder + 1) {
      this._estimateBetween(this.lastOrder, order, v.enterIdx);
    }
    const orderWarn = order < this.lastOrder;
    if (orderWarn) this._warn(`通過順序が行先と矛盾: ${st.name}`);
    const best = this._interp(v.minIdx, st);
    const pa = {
      id: this._nextId(st),
      ...this._snapshot(st),
      passT: v.forceT ?? best.t,
      enterT: v.enterT,
      exitT: v.exitT ?? null,
      minDist: Math.round(best.d * 10) / 10,
      stopFlag: v.stopFlag,
      stopSec: v.stopSec,
      estimated: false,
      orderWarn,
    };
    this.meta.set(pa, { visit: v, minIdx: v.minIdx, prevOrder: this.lastOrder, prevPassage: this.lastPassage });
    this.passages.push(pa);
    if (order > this.lastOrder) {
      this.lastOrder = order;
      this.lastPassage = pa;
    }
    if (order === 0) this.departed = true;
    this.on.passage?.(pa);
  }

  /** 判定円の中を一度も測位しなかった駅の通過時刻を、前後の測位点から推定する */
  _estimateBetween(fromOrder, toOrder, toIdx) {
    const fromIdx = this.meta.get(this.lastPassage)?.minIdx ?? 0;
    for (let o = fromOrder + 1; o < toOrder; o++) {
      const st = this.route[o];
      if (this.passCount.get(st.id) || this.visits.has(st.id)) continue;
      let best = null;
      for (let i = fromIdx; i < toIdx && i + 1 < this.pts.length; i++) {
        const a = this.pts[i];
        const b = this.pts[i + 1];
        const pr = projectOnSegment(st, a, b);
        if (!best || pr.d < best.d) best = { d: pr.d, t: a.t + pr.uc * (b.t - a.t), idx: pr.uc < 0.5 ? i : i + 1 };
      }
      if (!best) continue;
      const pa = {
        id: this._nextId(st),
        ...this._snapshot(st),
        passT: best.t,
        enterT: null,
        exitT: null,
        minDist: Math.round(best.d * 10) / 10,
        stopFlag: false,
        stopSec: 0,
        estimated: true,
        orderWarn: false,
      };
      this.meta.set(pa, { minIdx: best.idx });
      this.passages.push(pa);
      this.on.passage?.(pa);
    }
  }

  // ---------------- 停車の検知 ----------------
  _stopLogic(p, low) {
    const S = this.s;
    if (!this.stop) {
      if (low) {
        const sig = this._signalAt(p);
        const inTerm = this.visits.has(this.terminal?.id);
        this.stop = {
          startT: p.t,
          stationId: sig?.id ?? null,
          sectionId: sig ? '' : this._sectionId(),
          ignore: !this.departed, // 起点で発車前に立っているあいだは記録しない
          inTerm,
          fastRun: 0,
          fastT: null,
        };
        if (inTerm && this.departed && this.termFirstStopT == null) this.termFirstStopT = p.t;
      }
    } else {
      const s = this.stop;
      if (low) {
        s.fastRun = 0;
        s.fastT = null;
      } else {
        if (!s.fastRun) s.fastT = p.t;
        s.fastRun++;
        if (s.fastRun >= S.departFixes) this._endStop(s.fastT);
      }
    }
    const s = this.stop;
    if (s && s.inTerm && !s.ignore && p.t - s.startT >= S.arrivalSec * 1000) this._arrive();
  }

  _signalAt(p) {
    let best = null;
    for (const v of this.visits.values()) {
      if (v.st.type !== 'signal') continue;
      const d = dist(p, v.st);
      if (!best || d < best.d) best = { st: v.st, d };
    }
    return best?.st ?? null;
  }

  _sectionId() {
    const a = this.route[this.lastOrder];
    const b = this.route[this.lastOrder + 1];
    if (!a || !b) return '';
    const [x, y] = a.km <= b.km ? [a, b] : [b, a];
    return `${x.id}-${y.id}`;
  }

  _endStop(departT, open = false) {
    const s = this.stop;
    this.stop = null;
    if (!s || s.ignore) return;
    const sec = (departT - s.startT) / 1000;
    const rec = {
      id: `${this.run.id}|s|${s.startT}`,
      runId: this.run.id,
      stationId: s.stationId,
      sectionId: s.sectionId,
      startT: s.startT,
      departT: open ? null : departT,
      sec: Math.round(sec * 10) / 10,
      flag: sec >= this.s.flagSec,
    };
    this.stops.push(rec);
    this.on.stop?.(rec);
    if (!s.stationId) return;
    const v = this.visits.get(s.stationId);
    if (v) {
      v.stopFlag ||= rec.flag;
      v.stopSec += sec;
      return;
    }
    // 停車中に判定円を出てしまっていた場合は、確定済みの通過に反映する
    const pa = [...this.passages].reverse().find((x) => x.stationId === s.stationId && !x.estimated);
    if (pa) {
      pa.stopFlag ||= rec.flag;
      pa.stopSec = Math.round((pa.stopSec + sec) * 10) / 10;
      this.on.passage?.(pa);
    }
  }

  _closeAll() {
    const open = [...this.visits.values()].sort((a, b) => this.orderOf.get(a.st.id) - this.orderOf.get(b.st.id));
    this.visits.clear();
    for (const v of open) {
      // 終点で止まっているあいだの最接近は意味がないので、到着時刻を通過時刻とする
      if (v.st === this.terminal && this.arrivalT != null) v.forceT = this.arrivalT;
      this._finalize(v);
    }
  }

  _arrive() {
    const s = this.stop;
    this.arrivalT = this.termFirstStopT ?? s.startT;
    this.stop = null; // 到着の停車は停車記録にしない
    this._closeAll();
    this.arrived = true;
    this.on.arrive?.(this.arrivalT);
  }

  /** 手動の運転終了。到着時刻を返す */
  finish(t) {
    if (this.arrived) return this.arrivalT;
    const s = this.stop;
    const termOpen = this.visits.get(this.terminal?.id);
    if (s && s.inTerm && !s.ignore) {
      this.arrivalT = this.termFirstStopT ?? s.startT;
      this.stop = null;
    } else {
      if (s) this._endStop(t, true);
      this.arrivalT = termOpen ? this.termFirstStopT ?? termOpen.enterT : null;
    }
    this._closeAll();
    this.arrived = true;
    return this.arrivalT;
  }

  _warn(msg) {
    this.warnings.push(msg);
    this.on.warning?.(msg);
  }

  // ---------------- 表示用 ----------------
  status(now) {
    const lp = this.lastPassage;
    let inside = null;
    for (const v of this.visits.values()) {
      const o = this.orderOf.get(v.st.id);
      if (o > this.lastOrder && (!inside || o < this.orderOf.get(inside.id))) inside = v.st;
    }
    const next = inside || this.route[this.lastOrder + 1] || null;
    const cur = this.pts[this.pts.length - 1];
    let remain = null;
    if (next && cur) {
      if (inside) remain = dist(cur, next);
      else if (lp) {
        const odo0 = this.pts[this.meta.get(lp)?.minIdx ?? 0]?.odo ?? 0;
        remain = Math.max(0, Math.abs(next.km - lp.km) * 1000 - (cur.odo - odo0));
      } else remain = dist(cur, next);
    }
    const f = this.lastFix;
    return {
      next,
      inside: !!inside,
      lastPassage: lp,
      speedKmh: f ? f.speed * 3.6 : null,
      acc: f?.acc ?? null,
      poor: f?.poor ?? false,
      fixAge: f ? (now - f.t) / 1000 : null,
      stopping: this.stop && !this.stop.ignore ? (now - this.stop.startT) / 1000 : null,
      remain,
    };
  }
}
