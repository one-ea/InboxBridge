import type { Connector, NormalizedMessage, SendMessageInput, SendMessageResult } from "./connector.js";

export class StubWebConnector implements Connector {
  platform = "web";

  async start(): Promise<void> {
    throw new Error("当前版本尚未实现 Web connector。");
  }

  async stop(): Promise<void> {
    return;
  }

  async sendMessage(_input: SendMessageInput): Promise<SendMessageResult> {
    return { status: "failed", error: "当前版本尚未实现 Web connector。" };
  }

  async normalizeIncoming(_raw: unknown): Promise<NormalizedMessage> {
    throw new Error("当前版本尚未实现 Web connector。");
  }
}
