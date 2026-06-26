import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { isProPlus, getLimits } from '@/lib/plans'
import { processRookinhoChat } from '@/lib/rookinho-core'
import { sendTextMessage, markAsRead, downloadMedia } from '@/lib/whatsapp'
import { format } from 'date-fns'
import type Anthropic from '@anthropic-ai/sdk'

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } }

// Meta webhook verification (GET)
function handleVerification(req: NextApiRequest, res: NextApiResponse) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }
  return res.status(403).send('Forbidden')
}

interface WhatsAppMessage {
  from: string
  id: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
}

interface WhatsAppWebhookBody {
  object: string
  entry?: Array<{
    changes?: Array<{
      value?: {
        messaging_product: string
        messages?: WhatsAppMessage[]
        statuses?: unknown[]
      }
    }>
  }>
}

function extractMessages(body: WhatsAppWebhookBody): WhatsAppMessage[] {
  if (body.object !== 'whatsapp_business_account') return []
  const messages: WhatsAppMessage[] = []
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.value?.messages) {
        messages.push(...change.value.messages)
      }
    }
  }
  return messages
}

async function buildContentBlocks(msg: WhatsAppMessage): Promise<Anthropic.ContentBlockParam[]> {
  const blocks: Anthropic.ContentBlockParam[] = []

  if (msg.type === 'image' && msg.image) {
    try {
      const { buffer, mimeType } = await downloadMedia(msg.image.id)
      const base64 = buffer.toString('base64')
      const mediaType = mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } })
      if (msg.image.caption) blocks.push({ type: 'text', text: msg.image.caption })
    } catch (err) {
      console.error('[whatsapp] Failed to download image:', err)
      blocks.push({ type: 'text', text: '[Imagem enviada mas não foi possível carregar]' })
    }
  } else if (msg.type === 'document' && msg.document) {
    if (msg.document.mime_type === 'application/pdf') {
      try {
        const { buffer } = await downloadMedia(msg.document.id)
        const base64 = buffer.toString('base64')
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } })
        if (msg.document.caption) blocks.push({ type: 'text', text: msg.document.caption })
      } catch (err) {
        console.error('[whatsapp] Failed to download PDF:', err)
        blocks.push({ type: 'text', text: '[PDF enviado mas não foi possível carregar]' })
      }
    } else {
      blocks.push({ type: 'text', text: `[Arquivo "${msg.document.filename ?? 'documento'}" — formato não suportado no WhatsApp. Envie como imagem ou PDF.]` })
    }
  } else if (msg.type === 'text' && msg.text) {
    blocks.push({ type: 'text', text: msg.text.body })
  } else {
    blocks.push({ type: 'text', text: '[Tipo de mensagem não suportado. Envie texto, foto ou PDF.]' })
  }

  return blocks
}

async function processMessage(msg: WhatsAppMessage): Promise<void> {
  const phone = msg.from.startsWith('+') ? msg.from : `+${msg.from}`

  markAsRead(msg.id).catch(() => {})

  // Find user by WhatsApp phone
  const user = await db.user.findFirst({
    where: { whatsappPhone: phone },
    select: {
      id: true, name: true, plan: true,
      chatUsageMonth: true, chatUsageCount: true,
      chatFileMonth: true, chatFileCount: true,
      chatAnalysisMonth: true, chatAnalysisCount: true,
    },
  })

  if (!user) {
    await sendTextMessage(msg.from,
      'Oi! Sou o Rookinho, assistente financeiro do Rook Money 🐦\n\n' +
      'Não encontrei uma conta vinculada a esse número.\n\n' +
      'Pra usar o Rookinho no WhatsApp:\n' +
      '1. Tenha uma conta no Rook Money (rookmoney.com)\n' +
      '2. Assine o plano PRO+\n' +
      '3. Vincule seu WhatsApp em Configurações no app\n\n' +
      'Te espero lá! 😉'
    )
    return
  }

  if (!isProPlus(user.plan)) {
    await sendTextMessage(msg.from,
      'Oi, ' + user.name + '! O Rookinho no WhatsApp é exclusivo do plano PRO+ 😎\n\n' +
      'Faça upgrade em rookmoney.com/billing pra desbloquear!'
    )
    return
  }

  const yearMonth = format(new Date(), 'yyyy-MM')
  const limits = getLimits(user.plan)
  const chatCount = user.chatUsageMonth === yearMonth ? user.chatUsageCount : 0
  const fileCount = user.chatFileMonth === yearMonth ? user.chatFileCount : 0
  let analysisCount = user.chatAnalysisMonth === yearMonth ? user.chatAnalysisCount : 0

  if (limits.chat && chatCount >= limits.chat) {
    await sendTextMessage(msg.from,
      `Limite de ${limits.chat} mensagens/mês atingido. Renova no próximo mês!`
    )
    return
  }

  const hasFile = msg.type === 'image' || msg.type === 'document'
  if (hasFile && limits.chatFiles && fileCount >= limits.chatFiles) {
    await sendTextMessage(msg.from,
      `Limite de ${limits.chatFiles} arquivos/mês atingido.`
    )
    return
  }

  // Increment usage
  await db.user.update({
    where: { id: user.id },
    data: {
      chatUsageMonth: yearMonth, chatUsageCount: chatCount + 1,
      ...(hasFile ? { chatFileMonth: yearMonth, chatFileCount: fileCount + 1 } : {}),
    },
  })

  const contentBlocks = await buildContentBlocks(msg)
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: contentBlocks }]

  try {
    const result = await processRookinhoChat(user.id, user.name, messages, {
      analysisCount,
      analysisLimit: limits.chatAnalysis,
      onAnalysis: async () => {
        analysisCount++
        await db.user.update({
          where: { id: user.id },
          data: { chatAnalysisMonth: yearMonth, chatAnalysisCount: analysisCount },
        })
      },
    })

    if (result.message) {
      await sendTextMessage(msg.from, result.message)
    }
  } catch (err) {
    console.error('[whatsapp] Rookinho error:', err)
    await sendTextMessage(msg.from, 'Ops, tive um probleminha aqui. Tenta de novo daqui a pouco! 🐦')
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handleVerification(req, res)

  if (req.method !== 'POST') return res.status(405).end()

  // Always respond 200 immediately — Meta retries on non-200
  res.status(200).send('OK')

  const body = req.body as WhatsAppWebhookBody
  const messages = extractMessages(body)

  for (const msg of messages) {
    processMessage(msg).catch(err => {
      console.error('[whatsapp] processMessage error:', err)
    })
  }
}
