// zoompos(레지스터) ↔ 배율 — 화각표에서 유도한다.
//
// ★ 왜 이게 필요한가 (체크포인트 2026-07-21 미결 항목 B):
//   ParkAgent 뷰어는 zoom 을 배율 1~36 으로 다루고 `mapRange` 로 **선형** 매핑해 레지스터에 넣는다.
//   그런데 실측 화각표는 그 가정이 틀렸음을 보인다 — z15000→16384 구간에서 화각이 절반으로
//   꺾인다. 선형 매핑은 그 절벽을 직선으로 뭉개므로, 배율 명령과 실제 배율이 크게 어긋난다.
//
//   배율은 정의상 화각으로부터 나온다:   scale(z) = tan(hfov(z₀)/2) / tan(hfov(z)/2)
//
//   그 정의를 그대로 쓰면 선형 근사가 필요 없다.
//
// ★ 이 모듈은 **함수만 제공**한다. 뷰어의 실제 매핑 교체는 회귀 범위가 커서 별건이다(설계서 §2.2).
//
// 참고로 남겨 두는 관측: cam-001 표의 z16384 는 hfov 2.39° = 배율 **≈26x** 인데 장비 OSD 는
// x36 으로 표기한다. 표를 정본으로 삼되 이 불일치는 기록해 둔다(디지털 줌 포함 표기 가능성).

import type { CameraCalibration } from './calibration.js';

const DEG = Math.PI / 180;

interface Anchor {
  z: number;
  scale: number;
}

export class ZoomMap {
  private readonly anchors: Anchor[];

  /** 배율 1.0 의 기준이 되는 광각단 화각(도). */
  readonly baseHfov: number;

  constructor(calibration: CameraCalibration) {
    const rows = calibration.hfovCurve.toJSON() as Array<{ z: number; h: number }>;
    if (rows.length < 2) throw new TypeError('ZoomMap: 화각 앵커가 2개 미만입니다.');
    this.baseHfov = rows[0]!.h;
    const tanBase = Math.tan((this.baseHfov / 2) * DEG);
    this.anchors = rows.map((r) => ({ z: r.z, scale: tanBase / Math.tan((r.h / 2) * DEG) }));

    for (let i = 1; i < this.anchors.length; i++) {
      if (!(this.anchors[i]!.scale > this.anchors[i - 1]!.scale)) {
        throw new TypeError(
          `ZoomMap: 화각이 줌에 대해 단조 감소하지 않습니다 (z${this.anchors[i - 1]!.z}→z${this.anchors[i]!.z}). ` +
            '배율 역함수를 정의할 수 없습니다 — 표를 확인하세요.',
        );
      }
    }
  }

  /** [최소 배율, 최대 배율]. 표가 커버하는 범위 밖은 클램프된다. */
  get scaleDomain(): [number, number] {
    return [this.anchors[0]!.scale, this.anchors[this.anchors.length - 1]!.scale];
  }

  get zoomPosDomain(): [number, number] {
    return [this.anchors[0]!.z, this.anchors[this.anchors.length - 1]!.z];
  }

  /** zoompos → 배율. 정의역 밖은 클램프(★외삽 금지 — 광학이 포화한다). */
  scaleAt(zoomPos: number): number {
    return interp(this.anchors, Number(zoomPos), 'z', 'scale');
  }

  /** 배율 → zoompos. scaleAt 의 역함수. 정의역 밖은 클램프. */
  zoomPosFor(scale: number): number {
    return interp(this.anchors, Number(scale), 'scale', 'z');
  }
}

/** 앵커 배열에서 from 키로 찾아 to 키를 구간선형 보간(양끝 클램프). */
function interp(anchors: readonly Anchor[], v: number, from: 'z' | 'scale', to: 'z' | 'scale'): number {
  const n = anchors.length;
  if (!Number.isFinite(v) || v <= anchors[0]![from]) return anchors[0]![to];
  if (v >= anchors[n - 1]![from]) return anchors[n - 1]![to];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (v < anchors[mid]![from]) hi = mid;
    else lo = mid;
  }
  const a = anchors[lo]!;
  const b = anchors[lo + 1]!;
  const t = (v - a[from]) / (b[from] - a[from]);
  return a[to] + t * (b[to] - a[to]);
}
