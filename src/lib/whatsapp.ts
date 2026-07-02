const GRAPH_API = 'https://graph.facebook.com/v21.0'

function getConfig() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) throw new Error('WhatsApp env vars not configured')
  return { token, phoneId }
}

export async function sendTextMessage(to: string, text: string): Promise<void> {
  const { token, phoneId } = getConfig()

  // WhatsApp has a 4096 char limit per text message — split if needed
  const chunks = splitMessage(text, 4000)

  for (const chunk of chunks) {
    const res = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: chunk },
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('[whatsapp] sendTextMessage failed:', err)
    }
  }
}

export async function markAsRead(messageId: string): Promise<void> {
  const { token, phoneId } = getConfig()
  await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  }).catch(err => console.error('[whatsapp] markAsRead failed:', err))
}

export async function downloadMedia(mediaId: string, timeoutMs = 30_000): Promise<{ buffer: Buffer; mimeType: string }> {
  const { token } = getConfig()

  const metaRes = await fetch(`${GRAPH_API}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!metaRes.ok) throw new Error(`Failed to get media URL: ${metaRes.status}`)
  const meta = await metaRes.json() as { url: string; mime_type: string }

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!fileRes.ok) throw new Error(`Failed to download media: ${fileRes.status}`)
  const arrayBuffer = await fileRes.arrayBuffer()

  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type }
}

// Transcreve áudio via Groq Whisper (whisper-large-v3-turbo — rápido e baratíssimo,
// ~US$0,04 por hora de áudio). Requer GROQ_API_KEY no ambiente (Railway).
export async function transcribeAudio(buffer: Buffer, mimeType: string, timeoutMs = 45_000): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY not configured')

  const ext = mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('m4a') || mimeType.includes('mp4') ? 'm4a'
    : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
    : mimeType.includes('wav') ? 'wav'
    : mimeType.includes('webm') ? 'webm'
    : 'ogg'

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType || 'audio/ogg' }), `audio.${ext}`)
  form.append('model', 'whisper-large-v3-turbo')
  form.append('language', 'pt')
  form.append('response_format', 'text')

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq transcription failed: ${res.status} ${err}`)
  }
  return (await res.text()).trim()
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    // Try to break at a newline
    let breakAt = remaining.lastIndexOf('\n', maxLen)
    if (breakAt < maxLen * 0.5) breakAt = maxLen
    chunks.push(remaining.slice(0, breakAt))
    remaining = remaining.slice(breakAt).trimStart()
  }
  return chunks
}
