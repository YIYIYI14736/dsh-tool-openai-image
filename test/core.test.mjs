import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEndpoint,
  buildRequestBody,
  decodeBase64Payload,
  extractImageCandidates,
  isPrivateHostname,
  normalizedMediaType,
  sniffImageMediaType,
} from '../core.mjs'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='

test('buildEndpoint preserves existing v1 path', () => {
  assert.equal(buildEndpoint('http://example.test/v1', '/images/generations'), 'http://example.test/v1/images/generations')
})

test('buildRequestBody sends minimal compatible fields', () => {
  assert.deepEqual(buildRequestBody({ prompt: 'cat' }, {
    defaultModel: 'gpt-image-test', defaultSize: '1024x1024', responseMode: 'auto',
  }), { model: 'gpt-image-test', prompt: 'cat', n: 1, size: '1024x1024' })
})

test('buildRequestBody maps explicit response mode', () => {
  const body = buildRequestBody({ prompt: 'cat', output_format: 'webp' }, {
    defaultModel: 'gpt-image-test', defaultSize: '1024x1024', responseMode: 'url',
  })
  assert.equal(body.response_format, 'url')
  assert.equal(body.output_format, 'webp')
})

test('decode and sniff PNG payload', () => {
  const decoded = decodeBase64Payload(`data:image/png;base64,${PNG}`)
  assert.equal(decoded.declaredMediaType, 'image/png')
  assert.equal(sniffImageMediaType(decoded.data), 'image/png')
  assert.equal(normalizedMediaType(decoded.data, 'image/png'), 'image/png')
})

test('extracts base64, data URL, and URL candidates', () => {
  const candidates = extractImageCandidates({ data: [
    { b64_json: PNG },
    { url: `data:image/png;base64,${PNG}` },
    { url: 'https://images.example.test/a.png', revised_prompt: 'better' },
  ] })
  assert.deepEqual(candidates.map(item => item.kind), ['base64', 'base64', 'url'])
  assert.equal(candidates[2].revisedPrompt, 'better')
})

test('rejects empty image data', () => {
  assert.throws(() => extractImageCandidates({ data: [] }), /no images/)
})

test('recognizes private URL hosts', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.2', '169.254.1.1', '::1']) {
    assert.equal(isPrivateHostname(host), true, host)
  }
  assert.equal(isPrivateHostname('8.8.8.8'), false)
  assert.equal(isPrivateHostname('cdn.example.com'), false)
})
