import { describe, it, expect, afterEach, vi } from 'vitest';
import { LpdClient } from '../src/clients/LpdClient.js';
import type { ToolsConfig } from '../src/config/toolsConfig.js';

/**
 * 검증자(qa-tester): LpdClient polygons 파싱 → PlateBox.quad (설계 케이스 4).
 * 경계면: da_lpd_api polygons(검출별 4×[x,y] 픽셀) → normalizeQuad → PlateBox.quad(정규화).
 * 외부 REST 는 globalThis.fetch 스텁으로 모킹. quadBoundingRect 유도 rect 는 controlMath/plateMatch 에서 검증.
 */

const cfg: ToolsConfig['lpd'] = {
  endpoint: 'http://127.0.0.1:9082',
  detPath: '/lpd/api/v1/imgupload',
  timeoutMs: 8000,
  maxRetries: 0,
};

/** width×height 를 SOF0 에 담은 최소 유효 JPEG 버퍼. (jpeg.test.ts 패턴) */
function jpeg(width: number, height: number): Buffer {
  const b = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

/** fetch 스텁: 주어진 JSON body 를 200 OK 로 반환. */
function stubFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LpdClient.detect polygons → PlateBox.quad (경계면)', () => {
  it('polygons N개 → PlateBox.quad N개·정규화(TL→TR→BR→BL 순서 보존)', async () => {
    // 이미지 1000×500. 검출 2개(픽셀 4점).
    stubFetch({
      success: true,
      id: 1,
      polygons: [
        [[100, 50], [300, 50], [300, 150], [100, 150]],   // 축정렬 → (0.1,0.1)~(0.3,0.3)
        [[500, 100], [700, 200], [500, 300], [300, 200]], // 회전(마름모)
      ],
      confidences: [0.9, 0.8],
      classes: ['car_license_plate', 'car_license_plate'],
    });
    const client = new LpdClient(cfg);
    const boxes = await client.detect(jpeg(1000, 500));

    expect(boxes).toHaveLength(2);
    // 검출0: 축정렬 4점 정규화. y 는 /500.
    expect(boxes[0].quad).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.1 },
      { x: 0.3, y: 0.3 },
      { x: 0.1, y: 0.3 },
    ]);
    expect(boxes[0].confidence).toBe(0.9);
    expect(boxes[0].cls).toBe('car_license_plate');
    // 검출1: 회전 quad — 점 순서·좌표 보존(축정렬로 뭉개지지 않음).
    expect(boxes[1].quad).toEqual([
      { x: 0.5, y: 0.2 },
      { x: 0.7, y: 0.4 },
      { x: 0.5, y: 0.6 },
      { x: 0.3, y: 0.4 },
    ]);
    expect(boxes[1].confidence).toBe(0.8);
  });

  it('polygons: [] → 빈 배열(검출 0)', async () => {
    stubFetch({ success: false, id: 2, polygons: [], confidences: [], classes: [] });
    const client = new LpdClient(cfg);
    expect(await client.detect(jpeg(1000, 500))).toEqual([]);
  });

  it('confidences 누락 시 기본 1, classes 누락 시 car_license_plate 폴백', async () => {
    stubFetch({ success: true, id: 3, polygons: [[[0, 0], [100, 0], [100, 50], [0, 50]]] });
    const client = new LpdClient(cfg);
    const [box] = await client.detect(jpeg(1000, 500));
    expect(box.confidence).toBe(1);
    expect(box.cls).toBe('car_license_plate');
  });

  it('polygon 점수 != 4 → normalizeQuad throw(방어)', async () => {
    stubFetch({ success: true, id: 4, polygons: [[[0, 0], [100, 0], [100, 50]]], confidences: [0.9], classes: ['plate'] });
    const client = new LpdClient(cfg);
    await expect(client.detect(jpeg(1000, 500))).rejects.toThrow();
  });
});
