import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupArtifact } from '../domain/types.js';

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
    writeFileSync(this.file, JSON.stringify(artifact, null, 2), 'utf-8');
  }

  /** 산출물 로드. 없으면 null. */
  loadArtifact(): SetupArtifact | null {
    if (!existsSync(this.file)) return null;
    return JSON.parse(readFileSync(this.file, 'utf-8')) as SetupArtifact;
  }

  get path(): string {
    return this.file;
  }
}
