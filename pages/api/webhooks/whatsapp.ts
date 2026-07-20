import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { resolveDefaultAccountId } from '@/lib/account-balances'
import { sendWhatsApp, downloadTwilioMedia, validateTwilioSignature } from '@/lib/twilio'
import { parseReceipt } from '@/lib/receipt-parser'

export const config = { api: { bodyParser: false } }

async function readBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const fmt = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const rawBody = await readBody(req)
  const params  = Object.fromEntries(new URLSearchParams(rawBody))

  if (process.env.NODE_ENV === 'production') {
    const signature = (req.headers['x-twilio-signature'] as string) ?? ''
    const host      = (req.headers['x-forwarded-host'] as string) ?? (req.headers['host'] as string) ?? ''
    const proto     = (req.headers['x-forwarded-proto'] as string) ?? 'https'
    const url       = `${proto}://${host}/api/webhooks/whatsapp`
    const valid     = await validateTwilioSignature(signature, url, params)
    if (!valid) return res.status(403).json({ error: 'Invalid signature' })
  }

  const from     = params.From ?? ''
  const msgBody  = (params.Body ?? '').trim()
  const mediaUrl = params.MediaUrl0 ?? ''
  const numMedia = Number(params.NumMedia ?? 0)
  const phone    = from.replace(/^whatsapp:/, '')

  const user = await db.user.findUnique({ where: { whatsappPhone: phone }, select: { id: true, name: true } })

  if (!user) {
    await sendWhatsApp(phone, '👋 Número não vinculado ao Rook Money.\n\nAcesse *Configurações → WhatsApp* no app para vincular.').catch(() => {})
    return res.status(200).setHeader('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>')
  }

  const firstName = user.name.split(' ')[0]

  if (numMedia === 0) {
    const lower = msgBody.toLowerCase()
    if (['ajuda', 'help', 'oi', 'olá'].includes(lower)) {
      await sendWhatsApp(phone, `Olá, *${firstName}*! 👋\n\nEnvie uma 📸 *foto de comprovante* para eu registrar automaticamente!`)
    } else {
      await sendWhatsApp(phone, `📸 Envie uma *foto do comprovante* para eu registrar!\n\n_(Digite *ajuda* para mais informações)_`)
    }
    return res.status(200).setHeader('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>')
  }

  await sendWhatsApp(phone, '⏳ Lendo o comprovante...')

  try {
    const categories = await db.category.findMany({ where: { OR: [{ userId: user.id }, { isDefault: true }] }, select: { id: true, name: true, icon: true } })
    const { base64, contentType } = await downloadTwilioMedia(mediaUrl)
    const receipt = await parseReceipt(base64, contentType, categories)

    if (receipt.amount <= 0) {
      await sendWhatsApp(phone, '⚠️ Não consegui identificar um valor. Tente uma foto mais nítida.')
      return res.status(200).setHeader('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>')
    }

    const category = receipt.categoryId
      ? categories.find(c => c.id === receipt.categoryId)
      : categories.find(c => c.name.toLowerCase().includes('outros')) ?? categories[0]

    await db.transaction.create({ data: { amount: receipt.amount, type: receipt.type, description: receipt.description, date: new Date(receipt.date + 'T12:00:00'), userId: user.id, categoryId: category?.id ?? categories[0]?.id, accountId: await resolveDefaultAccountId(user.id) } })

    const typeEmoji = receipt.type === 'EXPENSE' ? '💸' : '💰'
    await sendWhatsApp(phone, `${typeEmoji} *${receipt.type === 'EXPENSE' ? 'Despesa' : 'Receita'} registrada!*\n\n💵 ${fmt(receipt.amount)}\n📌 ${receipt.description}\n🏷️ ${category?.icon ?? ''} ${category?.name ?? ''}\n\n_Acesse o app para editar._`)
  } catch (err) {
    console.error('[WhatsApp webhook]', err)
    await sendWhatsApp(phone, '❌ Erro ao processar. Tente novamente ou registre manualmente no app.').catch(() => {})
  }

  return res.status(200).setHeader('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>')
}
