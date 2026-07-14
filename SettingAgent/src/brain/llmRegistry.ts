/**
 * 런타임 LLM 모델 선택기 인터페이스.
 * 뷰어 라우트가 AgentRuntime 구상 타입에 결합되지 않도록 최소 계약만 노출한다(방식: 동일 인스턴스 활성 프로필 스왑).
 */
export interface LlmModelSelector {
  /** 등록된 프로필 목록(활성 플래그 포함). */
  listModels(): { id: string; name: string; provider: string; model: string; active: boolean }[];
  /** 활성 프로필 전환. 존재하지 않는 id 면 { ok: false }(활성 불변). */
  selectModel(id: string): { ok: boolean; activeModel?: string };
}
