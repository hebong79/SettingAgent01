// 바닥 ROI 정본(PtzCamRoi.json)의 **파생 파일 경로**(순수, IO 0).
//
// 왜 config 신규 키가 아니라 파생인가(설계 §2-1):
//   세 파일(정본 / `_auto` 감사기록 / `.bak` 백업)은 **반드시 같은 짝**이어야 한다. 독립 설정이 가능하면
//   "manual=PlaceA / auto=PlaceB" 같은 잘못된 짝이 만들어지고, 그 오류는 **정본 덮어쓰기 시점**에야 드러난다.
//   → 신규 설정 키 0. 경로는 전부 `store.placeRoiFile` 하나에서 파생한다.
//
// 경로 구분자는 **입력 문자열 그대로 보존**한다(node:path 의 정규화로 `/` 가 `\` 로 바뀌지 않게).

interface SplitPath {
  /** 마지막 구분자까지(구분자 포함). 구분자가 없으면 빈 문자열. */
  prefix: string;
  base: string;
  /** 점 포함 확장자(`.json`). 확장자 없으면 빈 문자열. */
  ext: string;
}

function splitPath(file: string): SplitPath {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const prefix = file.slice(0, cut + 1);
  const name = file.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  // dot>0 만 확장자로 본다 — `.hidden` 은 확장자가 아니라 이름이다.
  return dot > 0
    ? { prefix, base: name.slice(0, dot), ext: name.slice(dot) }
    : { prefix, base: name, ext: '' };
}

/** 경로 → 파일명(구분자 뒤). 응답·메시지에 서버 절대경로를 흘리지 않기 위해 쓴다. */
export function fileNameOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return file.slice(cut + 1);
}

/** `…/PtzCamRoi.json` → `…/PtzCamRoi_auto.json`. 확장자가 없으면 뒤에 `_auto`. */
export function autoPlaceRoiPathOf(manualFile: string): string {
  const { prefix, base, ext } = splitPath(manualFile);
  return `${prefix}${base}_auto${ext}`;
}

/**
 * `…/PtzCamRoi.json` + ISO → `…/PtzCamRoi.20260728T101530Z.bak.json`.
 * 타임스탬프는 파일명 안전 문자(영숫자)만 남긴다 — 밀리초는 버린다(초 단위로 충분·가독).
 */
export function backupPlaceRoiPathOf(manualFile: string, iso: string): string {
  const { prefix, base, ext } = splitPath(manualFile);
  const ts = iso.replace(/\.\d+Z$/, 'Z').replace(/[^0-9A-Za-z]/g, '');
  return `${prefix}${base}.${ts}.bak${ext}`;
}
