import { z } from 'zod';
import { Logger } from '@nestjs/common';

const logger = new Logger('AiConfig');

/**
 * Zod schema for AI-related environment variables.
 * GEMINI_API_KEY is required when AI_ENABLED is true.
 */
export const AiConfigSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gemini-2.5-flash'),
  AI_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AiConfig = z.infer<typeof AiConfigSchema>;

/**
 * Parse and validate AI configuration from environment variables.
 * Returns a validated config object, or null if AI is disabled / unconfigured.
 */
export function parseAiConfig(): AiConfig | null {
  const result = AiConfigSchema.safeParse({
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_ENABLED: process.env.AI_ENABLED,
  });

  if (!result.success) {
    logger.warn(
      `AI configuration validation failed: ${result.error.message}. AI features will be disabled.`,
    );
    return null;
  }

  const config = result.data;

  if (config.AI_ENABLED && !config.GEMINI_API_KEY) {
    logger.warn(
      'AI_ENABLED is true but GEMINI_API_KEY is not set. AI features will be disabled.',
    );
    return { ...config, AI_ENABLED: false };
  }

  if (!config.AI_ENABLED) {
    logger.log('AI features are disabled (AI_ENABLED=false).');
  } else {
    logger.log(`AI features enabled with model: ${config.AI_MODEL}`);
  }

  return config;
}
