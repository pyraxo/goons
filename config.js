/**
 * Central config for model. Set OPENAI_MODEL in .env to override.
 * Server: env.js loads .env before this. Client: Vite injects via define.
 */
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';
