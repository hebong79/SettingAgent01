import { describe, expect, it } from 'vitest';
import { cleanPresetName, isAssignedPreset, parsePresetsXml, parseSoapFault } from '../src/clients/onvif/presetParse.js';

/**
 * ONVIF GetPresetsResponse 파싱.
 *
 * 표본은 **실장비 응답 그대로**다(192.168.0.153 / 192.168.0.154, 2026-07-30 실측):
 * - 설정된 칸: `<tt:Name>EV1\n</tt:Name>`  ← 개행이 **뒤**
 * - 미설정 칸: `<tt:Name>\n21</tt:Name>`   ← 제어문자가 **앞**, 나머지는 토큰의 뒤 두 자리
 * 장비는 저장 여부와 무관하게 255칸을 전부 돌려주므로 이 구분이 목록의 전부다.
 */

const PRESET = (token: string, name: string) =>
  `<tptz:Preset token="${token}"><tt:Name>${name}</tt:Name>` +
  '<tt:PTZPosition><tt:PanTilt x="0" y="0"></tt:PanTilt><tt:Zoom x="0"></tt:Zoom></tt:PTZPosition></tptz:Preset>';

const RESPONSE = (...presets: string[]) =>
  '<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope><SOAP-ENV:Body>' +
  `<tptz:GetPresetsResponse>${presets.join('')}</tptz:GetPresetsResponse>` +
  '</SOAP-ENV:Body></SOAP-ENV:Envelope>';

describe('presetParse — 장비 프리셋 목록 파싱', () => {
  it('설정된 프리셋만 남기고 미설정 슬롯(제어문자 + 번호 뒤 두 자리)은 제외한다', () => {
    const xml = RESPONSE(
      PRESET('001', 'EV1\n'),
      PRESET('002', 'EV2\n'),
      PRESET('021', '\n21'),
      PRESET('030', 'test\n'),
      PRESET('100', '\n00'),
      PRESET('131', 'preset131\n'),
      PRESET('255', '\n55'),
    );
    expect(parsePresetsXml(xml)).toEqual([
      { token: '001', name: 'EV1', number: 1 },
      { token: '002', name: 'EV2', number: 2 },
      { token: '030', name: 'test', number: 30 },
      { token: '131', name: 'preset131', number: 131 },
    ]);
  });

  it('includeUnassigned 면 미설정 슬롯도 돌려준다(진단용)', () => {
    const all = parsePresetsXml(RESPONSE(PRESET('001', 'EV1\n'), PRESET('021', '\n21')), { includeUnassigned: true });
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({ token: '021', name: '21', number: 21 });
  });

  it('255칸 전량 응답에서 설정된 칸 수만 센다(실장비 형태)', () => {
    const slots = Array.from({ length: 255 }, (_, i) => {
      const token = String(i + 1).padStart(3, '0');
      return PRESET(token, i < 5 ? `EV${i + 1}\n` : `\n${token.slice(-2)}`);
    });
    const parsed = parsePresetsXml(RESPONSE(...slots));
    expect(parsed).toHaveLength(5);
    expect(parsed.map((p) => p.name)).toEqual(['EV1', 'EV2', 'EV3', 'EV4', 'EV5']);
    expect(parsed.map((p) => p.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('네임스페이스 접두사가 없거나 다른 장비 응답도 파싱한다', () => {
    const xml = '<Envelope><Body><GetPresetsResponse>' +
      '<Preset token="7"><Name>주차장 A</Name></Preset>' +
      '<ptz:Preset token="8"><ptz:Name>B동</ptz:Name></ptz:Preset>' +
      '</GetPresetsResponse></Body></Envelope>';
    expect(parsePresetsXml(xml)).toEqual([
      { token: '7', name: '주차장 A', number: 7 },
      { token: '8', name: 'B동', number: 8 },
    ]);
  });

  it('XML 엔티티를 되돌리고, 이름 없는(self-closing) 프리셋은 미설정으로 본다', () => {
    const xml = RESPONSE(PRESET('009', 'A&amp;B\n')) + '<Preset token="010"/>';
    expect(parsePresetsXml(xml)).toEqual([{ token: '009', name: 'A&B', number: 9 }]);
  });

  it('토큰이 수치가 아니거나 1~255 밖이면 number 를 주지 않는다(= 이동 불가 표시)', () => {
    const xml = RESPONSE(PRESET('PresetToken_1', 'Gate\n'), PRESET('300', 'Far\n'));
    expect(parsePresetsXml(xml)).toEqual([
      { token: 'PresetToken_1', name: 'Gate' },
      { token: '300', name: 'Far' },
    ]);
  });

  it('isAssignedPreset — 이름이 비면 미설정, 개행이 뒤면 설정, 앞이면서 번호 뒤2자리면 미설정', () => {
    expect(isAssignedPreset('001', '')).toBe(false);
    expect(isAssignedPreset('001', '   ')).toBe(false);
    expect(isAssignedPreset('001', 'EV1\n')).toBe(true);
    expect(isAssignedPreset('021', '\n21')).toBe(false);
    // 같은 "21" 이라도 제어문자가 앞에 없으면 사용자가 지은 이름으로 본다.
    expect(isAssignedPreset('021', '21')).toBe(true);
  });

  it('cleanPresetName — 제어문자 제거 + trim', () => {
    expect(cleanPresetName('\nEV1 \r\n')).toBe('EV1');
  });

  it('parseSoapFault — Fault 사유를 뽑고, 정상 응답에는 undefined', () => {
    const fault = '<Envelope><Body><SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>Sender</SOAP-ENV:Value></SOAP-ENV:Code>' +
      '<SOAP-ENV:Reason><SOAP-ENV:Text>Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault></Body></Envelope>';
    expect(parseSoapFault(fault)).toBe('Sender not Authorized');
    expect(parseSoapFault(RESPONSE(PRESET('001', 'EV1\n')))).toBeUndefined();
  });
});
