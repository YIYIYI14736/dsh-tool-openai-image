import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  apiErrorMessage,
  buildEndpoint,
  buildRequestBody,
  decodeBase64Payload,
  downloadImage,
  extensionFor,
  extractImageCandidates,
  imageValue,
  normalizedMediaType,
} from './core.mjs'

export const name = 'openai-image-tool'
export const inject = ['tools', 'attachments', 'credentials']

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
    revisedPrompt: { type: 'string' },
  },
}

function imageRef(image) {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } }),
  }
}

function resultContent(value) {
  const summary = `Generated ${value.images.length} image${value.images.length === 1 ? '' : 's'} with ${value.model}.`
  const content = [{ type: 'text', text: summary }]
  for (const image of value.images) {
    if (image.revisedPrompt) content.push({ type: 'text', text: `Revised prompt: ${image.revisedPrompt}` })
    content.push({ type: 'image', attachment: imageRef(image) })
  }
  return content
}

function normalizeConfig(config = {}) {
  const timeoutMs = Number(config.timeoutMs ?? 180000)
  const maxImageBytes = Number(config.maxImageBytes ?? 25 * 1024 * 1024)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive')
  if (!Number.isFinite(maxImageBytes) || maxImageBytes <= 0) throw new Error('maxImageBytes must be positive')
  const responseMode = config.responseMode ?? 'auto'
  if (!['auto', 'base64', 'url'].includes(responseMode)) throw new Error('responseMode must be auto, base64, or url')
  return {
    baseURL: config.baseURL ?? 'https://api.openai.com/v1',
    endpoint: config.endpoint ?? '/images/generations',
    apiKeyEnv: config.apiKeyEnv ?? 'OPENAI_API_KEY',
    defaultModel: config.defaultModel ?? 'gpt-image-1',
    defaultSize: config.defaultSize ?? '1024x1024',
    timeoutMs,
    maxImageBytes,
    responseMode,
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const endpoint = buildEndpoint(config.baseURL, config.endpoint)
  const apiKeyRef = credentialRef(config.apiKeyEnv)

  ctx.tools.register(defineTool({
    name: 'image_generate',
    description: 'Generate one or more images with the configured OpenAI-compatible image model. Use this when the user asks to create, draw, render, or generate an image. The generated images are returned as durable Harness attachments.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed image-generation prompt.' },
      model: { type: 'string', description: `Image model id. Defaults to ${config.defaultModel}.` },
      size: { type: 'string', description: `Requested image size. Defaults to ${config.defaultSize}.` },
      n: { type: 'integer', description: 'Number of images, from 1 to 4. Defaults to 1.' },
      quality: { type: 'string', description: 'Optional provider-specific quality value.' },
      background: { type: 'string', description: 'Optional provider-specific background value.' },
      output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Optional output file format.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          created: { type: 'integer' },
          images: { type: 'array', required: true, items: IMAGE_SCHEMA },
          usage: { type: 'json' },
        },
      },
      render: (_args, value) => resultContent(value),
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const credential = await ctx.credentials.resolve(apiKeyRef)
      if (!credential?.value) throw new Error(`credential ${config.apiKeyEnv} is not configured`)
      const body = buildRequestBody(args, config)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`image generation timed out after ${config.timeoutMs}ms`)), config.timeoutMs)
      const abort = () => controller.abort(exec.signal.reason)
      exec.signal.addEventListener('abort', abort, { once: true })
      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential.value}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
        exec.signal.removeEventListener('abort', abort)
      }
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`image API returned non-JSON content with HTTP ${response.status}`)
      }
      if (!response.ok) throw new Error(apiErrorMessage(response.status, payload, requestId))

      const candidates = extractImageCandidates(payload)
      const images = []
      for (let index = 0; index < candidates.length; index += 1) {
        exec.signal.throwIfAborted()
        const candidate = candidates[index]
        const acquired = candidate.kind === 'base64'
          ? decodeBase64Payload(candidate.value)
          : await downloadImage(candidate.value, { signal: exec.signal, maxBytes: config.maxImageBytes })
        if (acquired.data.byteLength > config.maxImageBytes) throw new Error(`image ${index + 1} exceeds ${config.maxImageBytes} byte limit`)
        const mediaType = normalizedMediaType(acquired.data, acquired.declaredMediaType)
        const extension = extensionFor(mediaType)
        const ref = await ctx.attachments.saveImage({
          data: acquired.data,
          mediaType,
          name: `generated-${Date.now()}-${index + 1}.${extension}`,
        })
        images.push(imageValue(ref, candidate.revisedPrompt))
      }
      const value = {
        model: body.model,
        ...(Number.isInteger(payload.created) ? { created: payload.created } : {}),
        images,
        ...(payload.usage === undefined ? {} : { usage: payload.usage }),
      }
      // A normal user-context image is rendered by the existing conversation image UI,
      // even when the generic custom-tool card has no dedicated image gallery.
      exec.deferContext(createUserMessage({ content: resultContent(value), source: { kind: 'user' } }))
      return value
    },
    presentCall: args => ({
      card: 'generic',
      title: `Generate image: ${args.prompt.slice(0, 60)}${args.prompt.length > 60 ? '…' : ''}`,
      kind: 'execute',
      rawInput: args,
    }),
  }))
}
