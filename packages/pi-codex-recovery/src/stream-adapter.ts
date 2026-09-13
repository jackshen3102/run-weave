import type { AssistantMessage, AssistantMessageEvent, Model, Api } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export function emptyMessage(model: Model<Api>): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: 'pending',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function visibleMessage(message: AssistantMessage): AssistantMessage {
  return { ...message, content: structuredClone(message.content.filter(c => c.type !== 'toolCall')) };
}
export class StreamAdapter {
  readonly stream = new AssistantMessageEventStream();
  latest: AssistantMessage;
  private lastContent?: AssistantMessage;
  constructor(model: Model<Api>) {
    this.latest = emptyMessage(model); this.stream.push({ type: 'start', partial: this.latest });
  }
  // Public Pi message_update consumers redraw from partial; tool previews are withheld until commit.
  update(message: AssistantMessage) {
    this.latest = visibleMessage(message);
    if (this.latest.content.length) this.lastContent = this.latest;
    this.stream.push({ type: 'text_delta', contentIndex: 0, delta: '', partial: this.latest });
  }
  sink(): AssistantMessageEventStream {
    const sink = new AssistantMessageEventStream();
    sink.push = (event: AssistantMessageEvent) => { if ('partial' in event) this.update(event.partial); };
    return sink;
  }
  finish(message: AssistantMessage) {
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      const failed = { ...(this.latest.content.length ? this.latest : this.lastContent ?? this.latest), stopReason: message.stopReason, errorMessage: message.errorMessage };
      this.stream.push({ type: 'error', reason: failed.stopReason as 'error' | 'aborted', error: failed });
    } else {
      this.stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
    }
    this.stream.end();
  }
}
