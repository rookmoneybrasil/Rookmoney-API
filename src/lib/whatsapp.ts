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

export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { token } = getConfig()

  // Step 1: get the media URL
  const metaRes = await fetch(`${GRAPH_API}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!metaRes.ok) throw new Error(`Failed to get media URL: ${metaRes.status}`)
  const meta = await metaRes.json() as { url: string; mime_type: string }

  // Step 2: download the actual file
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!fileRes.ok) throw new Error(`Failed to download media: ${fileRes.status}`)
  const arrayBuffer = await fileRes.arrayBuffer()

  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type }
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
