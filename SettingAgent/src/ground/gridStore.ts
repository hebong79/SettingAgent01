// 지면 격자 영속화(data/Place01/ground_grid.json). 설계 §5-1 — DB 아닌 **파일**.
//
// 근거: ① DB 스키마는 my_db_table.md 기준 6테이블 정본으로 확정 — 새 테이블은 그 결정과 충돌.
//       ② 격자는 PtzCamRoi.json 과 **같은 계층의 저작물**이다. ③ 골든 해시를 파일 문자열로 직접 봉인 가능.
//
// ★ 정본 흐름(리더 D-1): 격자(authored) → **PtzCamRoi.json** → slot_setup(파생).
//   이 파일은 `slot_setup` 에 **직접 쓰지 않는다**. DB 쓰기 신규 코드 0줄.
//
// ★ 설계서와 다른 점: 카메라 1대가 격자 **여러 개**(`grids: GroundGrid[]`)를 가진다.
//   실측상 한 카메라가 방위·위상이 다른 주차열을 여러 개 보기 때문 — groundGrid.ts 상단 ★★ 참조.
//
// 모든 수치는 `stringify5`(round5) 로 기록한다(영속화 5자리 규약, TEXT writer 필수).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { round5, stringify5 } from '../util/round.js';
import type { CameraGroundConstants } from './groundBootstrap.js';
import type { GroundGrid } from './groundGrid.js';

export const GROUND_GRID_FILE_VERSION = 1;

/** 격자 1건 + 적용 이력. */
export interface StoredGrid {
  grid: GroundGrid;
  /** 이 격자를 PtzCamRoi.json 에 실제로 적용한 프리셋들(추적성). 미적용이면 빈 배열. */
  appliedPresets: number[];
  /** ISO8601. */
  updatedAt: string;
}

/** 카메라 1대분. */
export interface StoredCameraGrids {
  camIdx: number;
  constants: CameraGroundConstants;
  grids: StoredGrid[];
}

export interface GroundGridFile {
  version: number;
  cameras: StoredCameraGrids[];
}

export const emptyGroundGridFile = (): GroundGridFile => ({ version: GROUND_GRID_FILE_VERSION, cameras: [] });

/** 파일 → 구조체. 미설정/부재/파싱실패 → null(강등 철학, loadNormalizedPlaceRoi 와 같은 패턴). */
export async function readGroundGridFile(file?: string): Promise<GroundGridFile | null> {
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<GroundGridFile>;
    if (!parsed || !Array.isArray(parsed.cameras)) return null;
    return { version: Number(parsed.version) || GROUND_GRID_FILE_VERSION, cameras: parsed.cameras };
  } catch {
    return null;
  }
}

/** 구조체 → 파일(stringify5, 디렉터리 자동 생성). 실패는 호출자에게 던진다(라우트가 500 처리). */
export async function writeGroundGridFile(file: string, data: GroundGridFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify5(data, 2), 'utf8');
}

/**
 * 격자 동일성 키 — **주차열(strip) 1개를 식별**한다. 방위 + 두 축의 lattice 위상(피치로 나눈 나머지).
 * 격자 창(cols/rows/colStart)이나 셀 배정은 같은 열의 다른 '보기'일 뿐이므로 키에 넣지 않는다.
 * 전부 `round5` 후 문자열화 — 부동소수 흔들림으로 같은 열이 둘로 갈라지지 않게 한다(결정론).
 */
export function gridKeyOf(grid: GroundGrid): string {
  const DEG = Math.PI / 180;
  const c = Math.cos(grid.thetaDeg * DEG);
  const s = Math.sin(grid.thetaDeg * DEG);
  const mod = (v: number, p: number): number => (p > 0 ? ((v % p) + p) % p : v);
  const ou = mod(grid.originM.a * c + grid.originM.b * s, grid.colPitchM);
  const ov = mod(grid.originM.a * -s + grid.originM.b * c, grid.rowPitchM);
  // 위상은 0.01m 격자로 양자화한다 — 같은 열을 두 번 부트스트랩해도 수 mm 차이로 갈라지지 않게.
  const q = (v: number): number => Math.round(v * 100) / 100;
  return [round5(grid.thetaDeg).toFixed(3), q(ou).toFixed(2), q(ov).toFixed(2)].join('|');
}

/**
 * 카메라 1대의 상수 + 격자 upsert(순수·불변). 카메라 목록은 camIdx asc 정렬(결정론).
 *
 * ★ 격자는 **주차열 단위로 누적**한다(QA 우선순위5). 실데이터의 실상이 "카메라 1대 = 주차열 여러 개"이므로
 *   통째 교체는 설계 의도와 정면 충돌한다. 같은 열(`gridKeyOf` 일치)이면 갱신, 다른 열이면 **추가**한다.
 *   `constants` 는 카메라 상수(프리셋 불변량)라 최신 부트스트랩 값으로 갱신한다.
 * 정렬: 격자는 `gridKeyOf` asc 로 고정(파일 바이트 결정론 — 부트스트랩 순서에 의존하지 않는다).
 * 파일 포맷은 그대로다(`grids` 는 처음부터 배열) — 기존 파일 호환 유지.
 */
export function upsertCameraGrids(file: GroundGridFile, entry: StoredCameraGrids): GroundGridFile {
  const prev = file.cameras.find((c) => c.camIdx === entry.camIdx);
  const rest = file.cameras.filter((c) => c.camIdx !== entry.camIdx);
  const byKey = new Map<string, StoredGrid>();
  for (const g of prev?.grids ?? []) byKey.set(gridKeyOf(g.grid), g);
  for (const g of entry.grids) byKey.set(gridKeyOf(g.grid), g); // 같은 열 → 갱신, 새 열 → 추가.
  const grids = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
  return {
    version: GROUND_GRID_FILE_VERSION,
    cameras: [...rest, { ...entry, grids }].sort((a, b) => a.camIdx - b.camIdx),
  };
}
