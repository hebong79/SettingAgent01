import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedQuad, NormalizedRect, SetupArtifact } from '../domain/types.js';
import { rectToQuad } from '../domain/geometry.js';
import { stringify5 } from '../util/round.js';

/**
 * 셋업 산출물(Preset/ParkingSlot/GlobalSlotIndex)을 JSON 파일로 영속화.
 * Action/DM 이 읽는 공유 계약이므로 단순·안정 포맷(JSON)을 사용한다(아키텍처 §6).
 */
export class Repository {
  private readonly file: string;
  constructor(private dataDir: string) {
    this.file = join(dataDir, 'setup_artifact.json');
  }

  /** 산출물 저장(디렉터리 자동 생성). */
  saveArtifact(artifact: SetupArtifact): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.file, stringify5(artifact, 2), 'utf-8');
  }

  /** 산출물 로드. 없으면 null. 구데이터(plateRoiByPreset=rect)는 로드 시 quad 로 승격(하위호환). */
  loadArtifact(): SetupArtifact | null {
    if (!existsSync(this.file)) return null;
    const artifact = JSON.parse(readFileSync(this.file, 'utf-8')) as SetupArtifact;
    promotePlateRois(artifact);
    return artifact;
  }

  get path(): string {
    return this.file;
  }
}

/** rect 형태 감지: {x,y,w,h}(w 키 존재)면 구 rect, 4원소 배열이면 신 quad. */
function isRect(v: unknown): v is NormalizedRect {
  return typeof v === 'object' && v !== null && 'w' in (v as Record<string, unknown>);
}

/** 구데이터 plateRoiByPreset(rect) → quad 승격(제자리 변형). 이미 quad(배열)면 무변경. */
function promotePlateRois(artifact: SetupArtifact): void {
  for (const slot of artifact.slots ?? []) {
    const plate = slot.plateRoiByPreset as Record<string, unknown> | undefined;
    if (!plate) continue;
    for (const key of Object.keys(plate)) {
      const v = plate[key];
      if (isRect(v)) {
        (slot.plateRoiByPreset as Record<string, NormalizedQuad>)[key] = rectToQuad(v);
      }
    }
  }
}
