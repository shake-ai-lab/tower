// エージェント実装（Claude / Codex）が満たす共通インターフェース。Manager と index.ts はこれだけを見る。
import type { SavedAttachment } from '../attachments.ts';

export interface AgentRunner {
  readonly id: string;
  /** firstMessage を送って開始。resumeFrom があれば会話の続きから。attachments = 指示に添えた画像・ファイル */
  start(firstMessage: string, resumeFrom?: string, attachments?: SavedAttachment[], historyText?: string, asyncQuestionId?: string): void;
  /** 追加指示 */
  send(text: string, attachments?: SavedAttachment[], historyText?: string, asyncQuestionId?: string): void;
  stop(): Promise<void>;
  /**
   * 状態（報告あり・エラーなど）は変えずに、エージェントのプロセスを手放す。手放したら true。
   * force = false: 手が空いている時（判断待ち・裏の作業・裏取りが無い）だけ。true: 会話が終わった・エラーで止まった後の後始末。
   * 次の指示は Manager が新しいランナーで会話の続きから再開する
   */
  release?(force: boolean): boolean;
  setPermissionMode?(mode: import('@tower/shared').PermissionChoice): Promise<void>;
  /** 許可要求への回答。対応していないエージェントは false */
  resolvePermission(requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): boolean;
  /** 質問への回答。対応していないエージェントは false */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean;
  answerForm?(body: import('@tower/shared').FormAnswerBody): boolean;
}
