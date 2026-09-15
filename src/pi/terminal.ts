import { InteractiveMode, type AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
export function terminal(runtime: AgentSessionRuntime) { return new InteractiveMode(runtime, { migratedProviders: [] }); }
