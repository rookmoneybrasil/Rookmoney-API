import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { isProPlus, getLimits } from '@/lib/plans'
import { processRookinhoChat, checkBurstLimit } from '@/lib/rookinho-core'
import { sendTextMessage, sendListMessage, sendButtonMessage, markAsRead, downloadMedia, transcribeAudio } from '@/lib/whatsapp'
import { isMenuTrigger, handleMenuSelection, handleFlowStep, hasActiveFlow, clearFlow, menuGreeting, MAIN_MENU_ROWS, MENU_BUTTON_TEXT } from '@/lib/whatsapp-menu'
import type { MenuResult } from '@/lib/whatsapp-menu'
import { format } from 'date-fns'
import type Anthropic from '@anthropic-ai/sdk'

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } }

// ── In-memory stores (reset on deploy, acceptable for these use cases) ──

// Conversation history: userId → last N message pairs (expires after 30 min)
const conversationHistory = new Map<string, { messages: Anthropic.MessageParam[]; updatedAt: number }>()
const HISTORY_TTL = 30 * 60 * 1000 // 30 minutes
const MAX_HISTORY = 10 // last 10 messages (5 user + 5 assistant)

// Message deduplication: messageId set (expires after 5 min)
const processedMessages = new Map<string, number>()
const DEDUP_TTL = 5 * 60 * 1000

// Rate limiting for unlinked phones: phone → { count, windowStart }
const unlinkedRateLimit = new Map<string, { count: number; windowStart: number }>()
const RATE_LIMIT_WINDOW = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX = 3 // max 3 messages per minute from unlinked phones

// Cleanup stale entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of conversationHistory) if (now - v.updatedAt > HISTORY_TTL) conversationHistory.delete(k)
  for (const [k, v] of processedMessages) if (now - v > DEDUP_TTL) processedMessages.delete(k)
  for (const [k, v] of unlinkedRateLimit) if (now - v.windowStart > RATE_LIMIT_WINDOW) unlinkedRateLimit.delete(k)
}, 60 * 1000)

// ── Webhook verification ──

function handleVerification(req: NextApiRequest, res: NextApiResponse) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }
  return res.status(403).send('Forbidden')
}

// ── Types ──

interface WhatsAppMessage {
  from: string
  id: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string; voice?: boolean }
  interactive?: {
    type: string
    list_reply?: { id: string; title: string }
    button_reply?: { id: string; title: string }
  }
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

// ── WhatsApp logging (metadata only, never the message text) ──

function classifyType(type: string): string {
  return ['text', 'image', 'document', 'audio'].includes(type) ? type : 'unsupported'
}

function normalizePhone(from: string): string {
  return from.startsWith('+') ? from : `+${from}`
}

async function logWhatsApp(data: {
  userId?: string | null; phone: string
  direction: 'inbound' | 'outbound'; status: string
  messageType: string; error?: string
}): Promise<void> {
  await db.whatsAppLog.create({
    data: {
      userId: data.userId ?? null,
      phone: data.phone,
      direction: data.direction,
      status: data.status,
      messageType: data.messageType,
      error: data.error ?? null,
    },
  }).catch(e => console.error('[whatsapp-log] failed:', e))
}

// Wraps sendTextMessage + records the outbound result. Use everywhere we reply.
async function sendAndLog(to: string, text: string, userId: string | null, messageType = 'text') {
  const result = await sendTextMessage(to, text)
  await logWhatsApp({
    userId, phone: normalizePhone(to),
    direction: 'outbound',
    status: result.ok ? 'sent' : 'failed',
    messageType, error: result.error,
  })
  return result
}

// Envia o menu interativo + loga. Nao consome cota nem rajada: nao chama a IA.
async function sendMenuAndLog(to: string, userId: string | null, userName: string) {
  const result = await sendListMessage(to, menuGreeting(userName), MENU_BUTTON_TEXT, MAIN_MENU_ROWS)
  await logWhatsApp({
    userId, phone: normalizePhone(to),
    direction: 'outbound',
    status: result.ok ? 'sent' : 'failed',
    messageType: 'interactive', error: result.error,
  })
  return result
}

// Manda o resultado de um passo de menu/fluxo: botoes quando houver, senao texto.
async function sendMenuResult(to: string, userId: string, result: MenuResult) {
  if (!result.reply) return
  const send = result.buttons?.length
    ? () => sendButtonMessage(to, result.reply!, result.buttons!)
    : () => sendTextMessage(to, result.reply!)
  const res = await send()
  await logWhatsApp({
    userId, phone: normalizePhone(to),
    direction: 'outbound',
    status: res.ok ? 'sent' : 'failed',
    messageType: 'interactive', error: res.error,
  })
  return res
}

// ── Media download with timeout ──

const DOWNLOAD_TIMEOUT = 30_000

async function buildContentBlocks(msg: WhatsAppMessage): Promise<Anthropic.ContentBlockParam[]> {
  const blocks: Anthropic.ContentBlockParam[] = []

  if (msg.type === 'image' && msg.image) {
    try {
      const { buffer, mimeType } = await downloadMedia(msg.image.id, DOWNLOAD_TIMEOUT)
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
        const { buffer } = await downloadMedia(msg.document.id, DOWNLOAD_TIMEOUT)
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
  } else if (msg.type === 'audio' && msg.audio) {
    try {
      const { buffer, mimeType } = await downloadMedia(msg.audio.id, DOWNLOAD_TIMEOUT)
      const text = await transcribeAudio(buffer, mimeType)
      if (text) {
        blocks.push({ type: 'text', text })
      } else {
        blocks.push({ type: 'text', text: 'O usuario mandou um audio, mas nao deu pra entender. Peca em UMA frase curta pra ele repetir ou mandar por texto.' })
      }
    } catch (err) {
      console.error('[whatsapp] Failed to transcribe audio:', err)
      blocks.push({ type: 'text', text: 'O usuario mandou um audio, mas a transcricao falhou. Peca em UMA frase curta pra ele repetir ou mandar por texto.' })
    }
  } else if (msg.type === 'text' && msg.text) {
    blocks.push({ type: 'text', text: msg.text.body })
  } else {
    return []
  }

  return blocks
}

// ── Conversation history helpers ──

function getHistory(userId: string): Anthropic.MessageParam[] {
  const entry = conversationHistory.get(userId)
  if (!entry || Date.now() - entry.updatedAt > HISTORY_TTL) return []
  return entry.messages
}

function appendHistory(userId: string, userMsg: Anthropic.MessageParam, assistantText: string) {
  const existing = getHistory(userId)
  const updated = [
    ...existing,
    userMsg,
    { role: 'assistant' as const, content: assistantText },
  ].slice(-MAX_HISTORY)
  conversationHistory.set(userId, { messages: updated, updatedAt: Date.now() })
}

// ── Process message ──

async function processMessage(msg: WhatsAppMessage): Promise<void> {
  // Deduplication
  if (processedMessages.has(msg.id)) return
  processedMessages.set(msg.id, Date.now())

  const phone = msg.from.startsWith('+') ? msg.from : `+${msg.from}`

  markAsRead(msg.id).catch(() => {})

  const user = await db.user.findFirst({
    where: { whatsappPhone: phone },
    select: {
      id: true, name: true, plan: true,
      chatUsageMonth: true, chatUsageCount: true,
      chatFileMonth: true, chatFileCount: true,
      chatAnalysisMonth: true, chatAnalysisCount: true,
    },
  })

  const msgType = classifyType(msg.type)
  await logWhatsApp({ userId: user?.id ?? null, phone, direction: 'inbound', status: 'received', messageType: msgType })

  if (!user) {
    // Rate limit unlinked phones
    const now = Date.now()
    const rl = unlinkedRateLimit.get(msg.from)
    if (rl && now - rl.windowStart < RATE_LIMIT_WINDOW) {
      if (rl.count >= RATE_LIMIT_MAX) return
      rl.count++
    } else {
      unlinkedRateLimit.set(msg.from, { count: 1, windowStart: now })
    }

    await sendAndLog(msg.from,
      'Oi! Sou o Rookinho, assistente financeiro do Rook Money 🐦\n\n' +
      'Não encontrei uma conta vinculada a esse número.\n\n' +
      'Pra usar o Rookinho no WhatsApp:\n' +
      '1. Tenha uma conta no Rook Money (rookmoney.com)\n' +
      '2. Assine o plano PRO+\n' +
      '3. Vincule seu WhatsApp em Configurações no app\n\n' +
      'Te espero lá! 😉',
      null,
    )
    return
  }

  if (!isProPlus(user.plan)) {
    await sendAndLog(msg.from,
      'Oi, ' + user.name + '! O Rookinho no WhatsApp é exclusivo do plano PRO+ 😎\n\n' +
      'Faça upgrade em rookmoney.com/billing pra desbloquear!',
      user.id,
    )
    return
  }

  // ── Menu (atalho, NAO portao) ─────────────────────────────────────────────
  // Roda ANTES da cota e do limite de rajada de proposito: nada aqui chama a IA,
  // entao nao custa token nem consome mensagem do usuario. Texto livre, audio e
  // print NAO passam por aqui — vao direto pro Rookinho, que e o diferencial.

  // 1) Usuario tocou numa opcao do menu (ou num botao do fluxo guiado)
  const selectionId = msg.interactive?.list_reply?.id ?? msg.interactive?.button_reply?.id
  if (selectionId) {
    const result = await handleMenuSelection(selectionId, user.id, user.name)
    if (result.handled) {
      await sendMenuResult(msg.from, user.id, result)
      return
    }
    // Selecao desconhecida (menu antigo?) → cai pro Rookinho normalmente
  }

  // 2) Fluxo guiado em andamento → o texto e resposta de um passo.
  //    Se veio anexo/audio no meio, abandona o fluxo e deixa a IA cuidar.
  if (hasActiveFlow(user.id)) {
    if (msg.type === 'text' && msg.text) {
      const result = await handleFlowStep(user.id, msg.text.body)
      if (result?.handled) {
        await sendMenuResult(msg.from, user.id, result)
        return
      }
    } else {
      clearFlow(user.id)
    }
  }

  // 3) Mensagem que e SO saudacao/"menu"/"ajuda" → mostra o menu
  if (msg.type === 'text' && msg.text && isMenuTrigger(msg.text.body)) {
    await sendMenuAndLog(msg.from, user.id, user.name)
    return
  }

  const yearMonth = format(new Date(), 'yyyy-MM')
  const limits = getLimits(user.plan)
  const chatCount = user.chatUsageMonth === yearMonth ? user.chatUsageCount : 0
  const fileCount = user.chatFileMonth === yearMonth ? user.chatFileCount : 0
  let analysisCount = user.chatAnalysisMonth === yearMonth ? user.chatAnalysisCount : 0

  if (limits.chat && chatCount >= limits.chat) {
    await sendAndLog(msg.from,
      `Limite de ${limits.chat} mensagens/mês atingido. Renova no próximo mês!`,
      user.id,
    )
    return
  }

  // Rate limit de rajada (anti-abuso) — não é limite mensal; PRO+ segue ilimitado.
  const burst = checkBurstLimit(user.id)
  if (!burst.allowed) {
    await sendAndLog(msg.from,
      `Opa, muitas mensagens em pouco tempo! Espera uns ${burst.retryAfterMin} min que a gente continua. 😉`,
      user.id,
    )
    return
  }

  const hasFile = msg.type === 'image' || msg.type === 'document'
  if (hasFile && limits.chatFiles && fileCount >= limits.chatFiles) {
    await sendAndLog(msg.from,
      `Limite de ${limits.chatFiles} arquivos/mês atingido.`,
      user.id,
    )
    return
  }

  const contentBlocks = await buildContentBlocks(msg)
  if (contentBlocks.length === 0) {
    await sendAndLog(msg.from, 'Esse tipo de mensagem não é suportado. Envie texto, foto ou PDF.', user.id, msgType)
    return
  }

  const userMsg: Anthropic.MessageParam = { role: 'user', content: contentBlocks }
  const history = getHistory(user.id)
  const allMessages: Anthropic.MessageParam[] = [...history, userMsg]

  try {
    const result = await processRookinhoChat(user.id, user.name, allMessages, {
      channel: 'whatsapp',
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

    await db.user.update({
      where: { id: user.id },
      data: {
        chatUsageMonth: yearMonth, chatUsageCount: chatCount + 1,
        ...(hasFile ? { chatFileMonth: yearMonth, chatFileCount: fileCount + 1 } : {}),
      },
    })

    if (result.message) {
      // Store text-only version in history
      const userTextContent = msg.text?.body ?? (msg.image?.caption ?? (msg.document?.caption ?? '[arquivo]'))
      appendHistory(user.id, { role: 'user', content: userTextContent }, result.message)
      await sendAndLog(msg.from, result.message, user.id, msgType)
    }
  } catch (err) {
    console.error('[whatsapp] Rookinho error:', err)
    await sendAndLog(msg.from, 'Ops, tive um probleminha aqui. Tenta de novo daqui a pouco! 🐦', user.id, msgType)
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handleVerification(req, res)

  if (req.method !== 'POST') return res.status(405).end()

  // Always respond 200 immediately — Meta retries on non-200
  res.status(200).send('OK')

  const body = req.body as WhatsAppWebhookBody
  const messages = extractMessages(body)

  // Sequential processing to avoid race conditions on usage counters
  ;(async () => {
    for (const msg of messages) {
      try { await processMessage(msg) }
      catch (err) { console.error('[whatsapp] processMessage error:', err) }
    }
  })()
}
