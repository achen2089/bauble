import { readFileSync } from 'node:fs';
import { commands, commandMarkdown } from './registry.js';
import { usageError } from './errors.js';
const chapters = ['quickstart', 'commands', 'automation', 'configuration', 'recovery'];
export function topics() { return [...chapters, ...commands.map(c => c.name)]; }
function chapter(topic: string) { return topic === 'commands' ? '# Commands\n\n' + commandMarkdown() : readFileSync(new URL(`../../docs/${topic}.md`, import.meta.url), 'utf8'); }
export function documentation(topic?: string) {
  if (topic && !topics().includes(topic) && !['help', 'docs'].includes(topic)) usageError(`Unknown documentation topic ${topic}. Use bauble docs --list.`);
  const markdown = !topic ? '# Bauble manual\n\n' + chapters.map(c => `- [${c}](#${c})`).join('\n') + '\n\n' + chapters.map(chapter).join('\n\n') : chapters.includes(topic) ? chapter(topic) : commandMarkdown(topic);
  return { topic: topic ?? 'all', markdown };
}
