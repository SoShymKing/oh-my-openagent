import { deepMerge, isRecord } from "@oh-my-opencode/utils"
import type { OhMyOpenCodeConfig } from "../config"
import { lowerReasoningForModel, resolveAgentVariant } from "../shared/agent-variant"
import { getSessionPromptParams } from "../shared/session-prompt-params-state"
import { getModelCapabilities, log, resolveCompatibleModelSettings } from "../shared"

const SAFE_MAX_OUTPUT_TOKENS_FALLBACK = 4096

export type ChatParamsInput = {
  sessionID: string
  agent: { name?: string }
  model: { providerID: string; modelID: string }
  provider: { id: string }
  message: { variant?: string }
}

type ChatParamsHookInput = ChatParamsInput & {
  runtimeModel: Record<string, unknown>
}

export type ChatParamsOutput = {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  options: Record<string, unknown>
}



function buildChatParamsInput(raw: unknown): ChatParamsHookInput | null {
  if (!isRecord(raw)) return null

  const sessionID = raw.sessionID
  const agent = raw.agent
  const model = raw.model
  const provider = raw.provider
  const message = raw.message

  if (typeof sessionID !== "string") return null
  if (!isRecord(model)) return null
  if (!isRecord(provider)) return null
  if (!isRecord(message)) return null

  let agentName: string | undefined
  if (typeof agent === "string") {
    agentName = agent
  } else if (isRecord(agent)) {
    const name = agent.name
    if (typeof name === "string") {
      agentName = name
    }
  }
  if (!agentName) return null

  const providerID = model.providerID
  const modelID = typeof model.modelID === "string"
    ? model.modelID
    : typeof model.id === "string"
      ? model.id
      : undefined
  const providerId = provider.id
  if (typeof providerID !== "string") return null
  if (typeof modelID !== "string") return null
  if (typeof providerId !== "string") return null

  return {
    sessionID,
    agent: { name: agentName },
    model: { providerID, modelID },
    provider: { id: providerId },
    message,
    runtimeModel: model,
  }
}

function isChatParamsOutput(raw: unknown): raw is ChatParamsOutput {
  if (!isRecord(raw)) return false
  if (!isRecord(raw.options)) {
    raw.options = {}
  }
  return isRecord(raw.options)
}

export function createChatParamsHandler(args: {
  client?: unknown
  pluginConfig?: OhMyOpenCodeConfig
} = {}): (input: unknown, output: unknown) => Promise<void> {
  return async (input, output): Promise<void> => {
    const normalizedInput = buildChatParamsInput(input)
    if (!normalizedInput) return
    if (!isChatParamsOutput(output)) return

    let configuredReasoningEffort: string | undefined
    if (args.pluginConfig && typeof normalizedInput.message.variant !== "string") {
      const reasoning = resolveAgentVariant(args.pluginConfig, normalizedInput.agent.name)
      const lowered = lowerReasoningForModel(reasoning, {
        providerID: normalizedInput.model.providerID,
        modelID: normalizedInput.model.modelID,
        runtimeModel: normalizedInput.runtimeModel,
      })
      const variants = normalizedInput.runtimeModel.variants
      const preset = lowered.variant !== undefined && isRecord(variants)
        ? variants[lowered.variant]
        : undefined
      if (isRecord(preset)) {
        output.options = deepMerge(output.options, preset)
        if (typeof preset.reasoningEffort === "string") {
          configuredReasoningEffort = preset.reasoningEffort
        }
      } else if (lowered.reasoningEffort !== undefined) {
        output.options.reasoningEffort = lowered.reasoningEffort
        configuredReasoningEffort = lowered.reasoningEffort
      }
    }

    let hasStoredReasoningEffortOverride = false
    const storedPromptParams = getSessionPromptParams(normalizedInput.sessionID)
    if (storedPromptParams) {
      if (storedPromptParams.temperature !== undefined) {
        output.temperature = storedPromptParams.temperature
      }
      if (storedPromptParams.topP !== undefined) {
        output.topP = storedPromptParams.topP
      }
      if (
        typeof storedPromptParams.maxOutputTokens === "number" &&
        storedPromptParams.maxOutputTokens > 0
      ) {
        (output as Record<string, unknown>).maxOutputTokens = storedPromptParams.maxOutputTokens
      }
      if (storedPromptParams.options) {
        hasStoredReasoningEffortOverride = "reasoningEffort" in storedPromptParams.options
        output.options = {
          ...output.options,
          ...storedPromptParams.options,
        }
      }
    }

    const capabilities = getModelCapabilities({
      providerID: normalizedInput.model.providerID,
      modelID: normalizedInput.model.modelID,
    })

    const compatibility = resolveCompatibleModelSettings({
      providerID: normalizedInput.model.providerID,
      modelID: normalizedInput.model.modelID,
      desired: {
        variant: typeof normalizedInput.message.variant === "string"
          ? normalizedInput.message.variant
          : undefined,
        reasoningEffort: typeof output.options.reasoningEffort === "string"
          ? output.options.reasoningEffort
          : undefined,
        temperature: typeof output.temperature === "number" ? output.temperature : undefined,
        topP: typeof output.topP === "number" ? output.topP : undefined,
        maxTokens: typeof output.maxOutputTokens === "number" ? output.maxOutputTokens : undefined,
        thinking: isRecord(output.options.thinking) ? output.options.thinking : undefined,
      },
      capabilities,
    })

    if (compatibility.reasoningEffort !== undefined) {
      output.options.reasoningEffort = compatibility.reasoningEffort
    } else if (configuredReasoningEffort !== undefined && !hasStoredReasoningEffortOverride) {
      output.options.reasoningEffort = configuredReasoningEffort
    } else if ("reasoningEffort" in output.options) {
      delete output.options.reasoningEffort
    }

    if ("temperature" in compatibility) {
      if (compatibility.temperature !== undefined) {
        output.temperature = compatibility.temperature
      } else {
        delete output.temperature
      }
    }

    if ("topP" in compatibility) {
      if (compatibility.topP !== undefined) {
        output.topP = compatibility.topP
      } else {
        delete output.topP
      }
    }

    if ("maxTokens" in compatibility) {
      if (compatibility.maxTokens !== undefined && compatibility.maxTokens > 0) {
        output.maxOutputTokens = compatibility.maxTokens
      } else {
        const originalMaxOutputTokens = typeof output.maxOutputTokens === "number"
          ? output.maxOutputTokens
          : compatibility.maxTokens
        output.maxOutputTokens = SAFE_MAX_OUTPUT_TOKENS_FALLBACK
        if (typeof originalMaxOutputTokens === "number" && originalMaxOutputTokens <= 0) {
          log(
            `[plugin] maxOutputTokens=${originalMaxOutputTokens} is non-positive; using safe fallback ${SAFE_MAX_OUTPUT_TOKENS_FALLBACK}`,
          )
        }
      }
    }

    if ("thinking" in compatibility) {
      if (compatibility.thinking !== undefined) {
        output.options.thinking = compatibility.thinking
      } else {
        delete output.options.thinking
      }
    }
  }
}
