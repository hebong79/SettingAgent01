// ONVIF `GetPresetsResponse` 파싱(순수 함수 — 네트워크·전역 상태 없음).
//
// ★ 왜 ONVIF 인가: **Hucoms HTTP API v1.22 에는 프리셋 조회 명령이 없다.**
//   문서 8.4(preset_control.cgi)는 setpreset / gopreset / clearpreset 셋뿐이고, 실측으로도
//   `action=getpreset|getpresetlist|getpresetname|getpresetinfo` 는 전부 **204 빈 응답**,
//   `preset.cgi`·`presetname.cgi` 류는 404 였다(192.168.0.153, 2026-07-30).
//   같은 장비의 ONVIF 서비스는 `GetPresets` 를 정상 응답하므로 **목록 조회만** ONVIF 를 쓴다
//   (이동은 종전대로 Hucoms `gopreset` — 검증된 경로를 바꾸지 않는다).
//
// ★ 장비가 주지 않는 것(은닉 금지): 실측 응답의 `PTZPosition` 은 전 프리셋이 x=0/y=0/zoom=0 이다.
//   즉 **프리셋별 PTZ 값은 API 로 알 수 없다** — 이동한 뒤 `getptzfpos` 로 실측하는 수밖에 없다.

/** 장비에 저장된 프리셋 1건. `number` 는 Hucoms `gopreset` 에 넣을 1~255 정수(비수치 토큰이면 undefined). */
export interface DevicePreset {
  /** ONVIF 프리셋 토큰(장비 원문, 예: "001"). */
  token: string;
  /** 표시용 이름(제어문자 제거·trim, 예: "EV1"). */
  name: string;
  /** Hucoms preset_control 번호(1~255). 토큰이 수치가 아니면 undefined = 이동 불가. */
  number?: number;
}

const PRESET_BLOCK = /<(?:[\w.-]+:)?Preset\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?Preset>)/g;
const NAME_TAG = /<(?:[\w.-]+:)?Name\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Name>/;
const TOKEN_ATTR = /\btoken\s*=\s*"([^"]*)"/;

/** XML 기본 엔티티만 되돌린다(장비가 보내는 이름은 ASCII 범위다). */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 제어문자를 지우고 좌우 공백을 턴 표시용 이름. */
export function cleanPresetName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return decodeXml(raw).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/**
 * **미설정 슬롯 판정.**
 *
 * 장비는 저장 여부와 무관하게 슬롯 255칸을 전부 돌려준다. 실측(192.168.0.153/154)에서 미설정 칸의
 * `Name` 은 "3자리 번호의 **첫 글자가 제어문자(0x0A)로 바뀐**" 형태였다 —
 * `021 → "\n21"`, `100 → "\n00"`, `254 → "\n54"`. 반면 **설정된 칸은 `"EV1\n"` 처럼 개행이 뒤에 온다**.
 * 즉 판별식은 "제어문자가 앞에 오고 나머지가 토큰의 뒤 두 자리와 같은가"이다.
 *
 * ★ 한계(은닉 금지): 사용자가 프리셋 이름을 **번호의 뒤 두 자리와 똑같이**(예: 21번을 "21") 지어 두면
 *   미설정으로 오판한다. 장비가 저장 여부 플래그를 주지 않으므로 이름 말고는 근거가 없다.
 */
export function isAssignedPreset(token: string, rawName: string): boolean {
  const name = cleanPresetName(rawName);
  if (!name) return false;
  // eslint-disable-next-line no-control-regex
  const leadingControl = /^[\u0000-\u001F\u007F]/.test(decodeXml(rawName));
  return !(leadingControl && name === token.slice(-2));
}

/**
 * GetPresetsResponse XML → 프리셋 배열.
 * @param xml SOAP 응답 전문(네임스페이스 접두사는 장비마다 다르므로 접두사 무관하게 매칭한다).
 * @param opts.includeUnassigned true 면 미설정 슬롯도 포함(진단용). 기본은 설정된 것만.
 */
export function parsePresetsXml(xml: string, opts: { includeUnassigned?: boolean } = {}): DevicePreset[] {
  const presets: DevicePreset[] = [];
  PRESET_BLOCK.lastIndex = 0;
  for (let m = PRESET_BLOCK.exec(xml); m !== null; m = PRESET_BLOCK.exec(xml)) {
    const token = TOKEN_ATTR.exec(m[1] ?? '')?.[1];
    if (!token) continue;
    const rawName = NAME_TAG.exec(m[3] ?? '')?.[1] ?? '';
    if (!opts.includeUnassigned && !isAssignedPreset(token, rawName)) continue;
    const numeric = /^\d+$/.test(token) ? Number(token) : NaN;
    presets.push({
      token,
      name: cleanPresetName(rawName) || token,
      ...(Number.isInteger(numeric) && numeric >= 1 && numeric <= 255 ? { number: numeric } : {}),
    });
  }
  return presets;
}

/** SOAP Fault 의 사유 문자열(없으면 undefined). 인증 실패·미지원을 그대로 사용자에게 보여주기 위함. */
export function parseSoapFault(xml: string): string | undefined {
  if (!/<(?:[\w.-]+:)?Fault\b/.test(xml)) return undefined;
  const text = /<(?:[\w.-]+:)?Text\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Text>/.exec(xml)?.[1];
  const value = /<(?:[\w.-]+:)?Value\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Value>/.exec(xml)?.[1];
  return cleanPresetName(text ?? value ?? 'SOAP Fault') || 'SOAP Fault';
}
