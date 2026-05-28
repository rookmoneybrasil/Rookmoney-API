import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { getSessionFromRequest } from '@/lib/auth'
import { format } from 'date-fns'

const client = new Anthropic()

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const session = await getSessionFromRequest(req)
  if (!session) return res.status(401).json({ error: 'Não autenticado' })

  const { imageBase64, mediaType } = req.body as {
    imageBase64: string
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  }

  if (!imageBase64) return res.status(400).json({ error: 'Imagem não enviada' })

  const today = format(new Date(), 'yyyy-MM-dd')

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: `Analise esta imagem e extraia dados da transação. Retorne APENAS JSON:\n{"amount":<número>,"type":"EXPENSE|INCOME","description":"<60 chars>","date":"${today}","categoryName":"Alimentação|Transporte|Saúde|Lazer|Educação|Moradia|Vestuário|Tecnologia|Serviços|Outros","notes":null,"confidence":"high|medium|low"}\nSe não for comprovante: {"error":"Imagem não reconhecida"}` },
      ],
    }],
  })

  const raw = response.content.find(b => b.type === 'text')?.text ?? ''
  try {
    return res.status(200).json(JSON.parse(raw.trim()))
  } catch {
    return res.status(422).json({ error: 'Não foi possível extrair dados. Tente uma foto mais nítida.' })
  }
}
