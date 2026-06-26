import type { NextApiRequest, NextApiResponse } from 'next'
import type Anthropic from '@anthropic-ai/sdk'
import { getSessionFromRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { format } from 'date-fns'
import { getLimits, isPro } from '@/lib/plans'
import { processRookinhoChat } from '@/lib/rookinho-core'

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'Não autenticado' })

  const yearMonth = format(new Date(), 'yyyy-MM')

  const user = await db.user.findUnique({
    where:  { id: session.userId },
    select: { plan: true, chatUsageMonth: true, chatUsageCount: true, chatFileMonth: true, chatFileCount: true, chatAnalysisMonth: true, chatAnalysisCount: true, name: true },
  })
  if (!user || !isPro(user.plan)) return res.status(403).json({ error: 'pro_required', message: 'O assistente Rook é exclusivo do plano Pro.' })

  const limits        = getLimits(user.plan)
  const chatCount     = user.chatUsageMonth === yearMonth ? user.chatUsageCount : 0
  const fileCount     = user.chatFileMonth === yearMonth ? user.chatFileCount : 0
  let   analysisCount = user.chatAnalysisMonth === yearMonth ? user.chatAnalysisCount : 0
  const chatLimit     = limits.chat
  const fileLimit     = limits.chatFiles
  const analysisLimit = limits.chatAnalysis

  if (req.method === 'GET') {
    return res.status(200).json({
      used: chatCount, limit: chatLimit ?? 999, remaining: chatLimit ? chatLimit - chatCount : 999,
      files: { used: fileCount, limit: fileLimit ?? 999 },
      analysis: { used: analysisCount, limit: analysisLimit ?? 999 },
    })
  }

  if (req.method !== 'POST') return res.status(405).end()

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_unavailable', message: 'O assistente de IA está temporariamente indisponível.' })
  }

  if (chatLimit && chatCount >= chatLimit) {
    return res.status(429).json({ error: 'rate_limited', message: `Limite de ${chatLimit} mensagens/mês atingido. Renova no próximo mês.`, remaining: 0 })
  }

  const { messages } = req.body as { messages: Anthropic.MessageParam[] }
  const lastMsg = messages[messages.length - 1]
  const hasFile = Array.isArray(lastMsg?.content) && (lastMsg.content as unknown[]).some((b: unknown) => {
    const block = b as { type?: string }
    return block.type === 'image' || block.type === 'document'
  })
  if (hasFile && fileLimit && fileCount >= fileLimit) {
    return res.status(429).json({ error: 'file_limit', message: `Limite de ${fileLimit} arquivos/mês atingido. Faça upgrade pro Pro+ para envio ilimitado.` })
  }

  await db.user.update({
    where: { id: session.userId },
    data: {
      chatUsageMonth: yearMonth, chatUsageCount: chatCount + 1,
      ...(hasFile ? { chatFileMonth: yearMonth, chatFileCount: fileCount + 1 } : {}),
    },
  })

  const truncated = messages.slice(-10)
  const safeMessages = truncated[0]?.role === 'assistant' ? truncated.slice(1) : truncated

  try {
    const result = await processRookinhoChat(
      session.userId,
      user.name ?? session.name,
      safeMessages,
      {
        analysisCount,
        analysisLimit,
        onAnalysis: async () => {
          analysisCount++
          await db.user.update({
            where: { id: session.userId },
            data: { chatAnalysisMonth: yearMonth, chatAnalysisCount: analysisCount },
          })
        },
      },
    )

    return res.status(200).json({
      message: result.message,
      navigate: result.navigate,
      remaining: chatLimit ? chatLimit - (chatCount + 1) : 999,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    if (msg.includes('authentication') || msg.includes('api_key')) {
      return res.status(503).json({ error: 'ai_unavailable', message: 'O assistente de IA está temporariamente indisponível.' })
    }
    if (msg.includes('credit balance') || msg.includes('billing')) {
      return res.status(503).json({ error: 'ai_unavailable', message: 'O assistente de IA está temporariamente indisponível. Tente novamente mais tarde.' })
    }
    return res.status(500).json({ error: 'ai_error', message: 'Erro ao processar sua mensagem. Tente novamente.' })
  }
}
