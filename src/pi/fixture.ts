import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type Context, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
export const fixtureContexts: Context[] = [];
export function fixtureProvider(pi: ExtensionAPI) {
  pi.registerProvider('bauble-fixture', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'credential-free-fixture', api: 'bauble-fixture',
    models: [{ id: 'deterministic', name: 'Bauble test fixture', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model: Model<any>, context: Context, options) {
      fixtureContexts.push(JSON.parse(JSON.stringify(context)) as Context);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = context.messages.at(-1);
        const prompt = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('')) : '';
        const call = prompt.startsWith('fixture:write ');
        const output: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'pending', usage: { input: context.messages.length, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: context.messages.length + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: output });
        if (options?.signal?.aborted) { output.stopReason = 'aborted'; output.errorMessage = 'Aborted'; stream.push({ type: 'error', reason: 'aborted', error: output }); stream.end(); return; }
        if (call) {
          const request: { path: string; content: string } = JSON.parse(prompt.slice('fixture:write '.length));
          const toolCall = { type: 'toolCall' as const, id: `fixture-${context.messages.length}`, name: 'write', arguments: request };
          output.content.push(toolCall); stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output }); stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: output }); output.stopReason = 'toolUse';
        } else { output.content.push({ type: 'text', text: 'Fixture settled.' }); stream.push({ type: 'text_start', contentIndex: 0, partial: output }); stream.push({ type: 'text_end', contentIndex: 0, content: 'Fixture settled.', partial: output }); output.stopReason = 'stop'; }
        stream.push({ type: 'done', reason: output.stopReason, message: output }); stream.end();
      }); return stream;
    }
  });
}
