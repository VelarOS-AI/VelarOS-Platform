import { z } from 'zod'

export const AgentSessionLifecycleStatusSchema = z.enum([
  'idle',
  'running',
  'interrupted',
  'failed',
])

export const AgentBackgroundAgentStateSchema = z.enum([
  'starting',
  'running',
  'completed',
  'failed',
  'stopped',
  'interrupted',
])
