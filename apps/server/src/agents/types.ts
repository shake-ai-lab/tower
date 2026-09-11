// エージェント実装（Claude / Codex）が満たす共通インターフェース。Manager と index.ts はこれだけを見る。
export interface AgentRunner {
  readonly id: string;
  /** firstMessage を送って開始。resumeFrom があれば会話の続きから */
  start(firstMessage: string, resumeFrom?: string): void;
  /** 追加指示 */
  send(text: string): void;
  stop(): Promise<void>;
  setPermissionMode?(mode: import('@tower/shared').PermissionChoice): Promise<void>;
  /** 許可要求への回答。対応していないエージェントは false */
  resolvePermission(requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): boolean;
  /** 質問への回答。対応していないエージェントは false */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean;
}
