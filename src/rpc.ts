import { z } from 'zod';
export const Request = z.object({ operation: z.enum(['probe', 'configure-code-root', 'manifest', 'blob', 'ready', 'activate', 'status', 'revoke', 'attach', 'message-check', 'message', 'message-status', 'log', 'capture', 'fence', 'download', 'approve', 'finish']), root: z.string().max(4096), data: z.unknown() }).strict();
export type Request = z.infer<typeof Request>;
export type Rpc = (request: Request) => Promise<unknown>;
