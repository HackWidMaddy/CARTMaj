-- Add per-provider Ollama/OpenAI-compatible reasoning controls.
ALTER TABLE "user_llm_providers"
  ADD COLUMN "reasoning_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reasoning_effort" TEXT NOT NULL DEFAULT 'high';
