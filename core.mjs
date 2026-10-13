import { isIP } from 'node:net'

const IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
])

export function buildEndpoint(baseURL, endpoint = '/images/generations') {
  const base = String(baseURL ?? '').trim()
  if (!base) throw new Error('baseURL must be a non-empty URL')
  const url = new URL(base.endsWith('/') ? base : `${base}/`)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseURL must use http or https')
  const suffix = String(endpoint ?? '').trim().replace(/^\/+/, '')
  if (!suffix) throw new Error('endpoint must be non-empty')
  return new URL(suffix, url).toString()
}

export function buildRequestBody(args, config) {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) throw new Error('prompt must be a non-empty string')
  const n = args.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('n must be an integer from 1 to 4')
  const body = {
    model: String(args.model ?? config.defaultModel).trim(),
    prompt,
    n,
    size: String(args.size ?? config.defaultSize).trim(),
  }
  if (!body.model) throw new Error('model must be non-empty')
  if (!body.size) throw new Error('size must be non-empty')
  for (const key of ['quality', 'background', 'output_format']) {
    if (args[key] !== undefined && String(args[key]).trim()) body[key] = String(args[key]).trim()
  }
  if (config.responseMode && config.responseMode !== 'auto') body.response_format = config.responseMode === 'base64' ? 'b64_json' : 'url'
  return body
}

export function decodeBase64Payload(value) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error('empty base64 image payload')
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(text)
  const declared = match?.[1]?.toLowerCase()
  const encoded = (match?.[2] ?? text).replace(/\s+/g, '')
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('invalid base64 image payload')
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength === 0) throw new Error('empty decoded image payload')
  return { data: new Uint8Array(data), declaredMediaType: declared }
}

function starts(data, bytes) {
  return data.byteLength >= bytes.length && bytes.every((byte, index) => data[index] === byte)
}

function ascii(data, offset, value) {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

export function sniffImageMediaType(data) {
  if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(data, 0, 'GIF87a') || ascii(data, 0, 'GIF89a')) return 'image/gif'
  if (ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

export function extensionFor(mediaType) {
  const extension = IMAGE_TYPES.get(mediaType)
  if (!extension) throw new Error(`unsupported image media type: ${mediaType}`)
  return extension
}

export function normalizedMediaType(data, declared) {
  const sniffed = sniffImageMediaType(data)
  if (!sniffed) throw new Error('response bytes are not a supported PNG/JPEG/WebP/GIF image')
  if (declared && IMAGE_TYPES.has(declared) && declared !== sniffed) {
    throw new Error(`image media type mismatch: declared ${declared}, detected ${sniffed}`)
  }
  return sniffed
}

export function extractImageCandidates(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('image API returned a non-object response')
  if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error('image API response contains no images')
  return payload.data.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`image result ${index + 1} is not an object`)
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      return { kind: 'base64', value: item.b64_json, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined }
    }
    if (typeof item.url === 'string' && item.url.trim()) {
      if (item.url.startsWith('data:')) return { kind: 'base64', value: item.url, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined }
      return { kind: 'url', value: item.url, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined }
    }
    throw new Error(`image result ${index + 1} has neither b64_json nor url`)
  })
}

export function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const version = isIP(host)
  if (version === 4) {
    const parts = host.split('.').map(Number)
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0
  }
  if (version === 6) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')
  return false
}

export async function downloadImage(urlValue, { signal, maxBytes, fetchImpl = fetch }) {
  const url = new URL(urlValue)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('image URL must use http or https')
  if (isPrivateHostname(url.hostname)) throw new Error('image URL points to a local or private address')
  const response = await fetchImpl(url, { signal, redirect: 'follow', headers: { Accept: 'image/*' } })
  if (!response.ok) throw new Error(`image download failed with HTTP ${response.status}`)
  const finalURL = new URL(response.url || url)
  if (isPrivateHostname(finalURL.hostname)) throw new Error('image redirect points to a local or private address')
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`image exceeds ${maxBytes} byte limit`)
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mime && !mime.startsWith('image/')) throw new Error(`image URL returned non-image content type ${mime}`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > maxBytes) throw new Error(`image exceeds ${maxBytes} byte limit`)
  return { data, declaredMediaType: mime }
}

export function apiErrorMessage(status, payload, requestId) {
  const message = payload?.error?.message ?? payload?.error ?? payload?.message ?? payload?.detail
  const rendered = typeof message === 'string' ? message : message ? JSON.stringify(message) : 'unknown provider error'
  return `image API failed with HTTP ${status}: ${rendered}${requestId ? ` (request-id: ${requestId})` : ''}`
}

export function imageValue(ref, revisedPrompt) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
    ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
  }
}
