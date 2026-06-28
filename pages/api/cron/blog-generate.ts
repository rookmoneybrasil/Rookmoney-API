import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { db } from '@/lib/db'
import { sendNewsletterEmail } from '@/lib/email'

const UNSPLASH_IMAGES: Record<string, string[]> = {
  'dicas': [
    'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=1200&h=630&fit=crop',
  ],
  'educacao-financeira': [
    'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1633158829585-23ba8f7c8caf?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=1200&h=630&fit=crop',
  ],
  'investimentos': [
    'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1642790106117-e829e14a795f?w=1200&h=630&fit=crop',
  ],
  'cripto': [
    'https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1621761191319-c6fb62004040?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=1200&h=630&fit=crop',
  ],
  'curiosidades': [
    'https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1553729459-afe8f2e2ed65?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=1200&h=630&fit=crop',
  ],
}

const CATEGORIES = ['dicas', 'educacao-financeira', 'investimentos', 'cripto', 'curiosidades']

function pickRandom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

async function fetchTrendingTopics(): Promise<string> {
  const sources = [
    'https://www.infomoney.com.br/',
    'https://www.cointelegraph.com.br/',
    'https://valorinveste.globo.com/',
  ]

  const results: string[] = []

  for (const url of sources) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RookMoneyBot/1.0)' },
        signal: AbortSignal.timeout(8000),
      })
      const html = await res.text()
      const titles = html.match(/<h[1-3][^>]*>([^<]{10,120})<\/h[1-3]>/gi)
        ?.map(h => h.replace(/<[^>]+>/g, '').trim())
        ?.filter(t => t.length > 15)
        ?.slice(0, 8)
      if (titles?.length) {
        results.push(`Fonte: ${url}\nManchetes: ${titles.join(' | ')}`)
      }
    } catch {}
  }

  return results.length > 0
    ? results.join('\n\n')
    : 'Não foi possível buscar notícias. Gere um artigo sobre um tema atemporal de finanças pessoais.'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  // Check if already generated today — max 1 per day
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayCount = await db.blogPost.count({
    where: { source: 'ai-generated', createdAt: { gte: todayStart } },
  })
  if (todayCount >= 1) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Already generated today' })
  }

  // Pick a category that hasn't been used in the last 3 days
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  const recentCategories = await db.blogPost.findMany({
    where: { createdAt: { gte: threeDaysAgo } },
    select: { category: true },
  })
  const usedCats = new Set(recentCategories.map(p => p.category))
  const availableCats = CATEGORIES.filter(c => !usedCats.has(c))
  const category = availableCats.length > 0 ? pickRandom(availableCats) : pickRandom(CATEGORIES)

  // Fetch trending news
  const trendingContext = await fetchTrendingTopics()

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const categoryLabel: Record<string, string> = {
    'dicas': 'dicas práticas de economia e organização financeira',
    'educacao-financeira': 'educação financeira (conceitos, estratégias, planejamento)',
    'investimentos': 'investimentos (renda fixa, variável, fundos, estratégias)',
    'cripto': 'criptomoedas e blockchain (Bitcoin, Ethereum, tendências, regulação)',
    'curiosidades': 'curiosidades sobre dinheiro, economia e finanças no Brasil e no mundo',
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Você é um redator especializado em finanças pessoais para o blog do Rook Money, um app brasileiro de controle financeiro.

DATA DE HOJE: ${new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })}. Use o ano correto (${new Date().getFullYear()}) em todos os títulos e referências temporais.

CONTEXTO — Notícias da semana:
${trendingContext}

TAREFA: Escreva um artigo de blog sobre ${categoryLabel[category] ?? category}.

REGRAS:
- Público: brasileiro, 20-40 anos, quer organizar finanças
- Tom: acessível, prático, sem jargão excessivo. Pode ser levemente informal
- Tamanho: 800-1200 palavras
- Use dados e exemplos reais quando possível
- Se relevante, conecte com as notícias da semana acima
- Inclua tabelas comparativas quando fizer sentido
- Adicione exatamente 2 marcadores "<!-- ad -->" no meio do conteúdo (pra inserir anúncios)
- NÃO mencione o Rook Money no corpo do texto (a CTA é automática)
- Escreva em PT-BR

FORMATO DE RESPOSTA (JSON):
{
  "title": "Título chamativo (50-80 chars)",
  "excerpt": "Resumo de 1-2 frases (max 160 chars)",
  "content": "Conteúdo em Markdown com ## headings, listas, tabelas, blockquotes",
  "imageAlt": "Descrição da imagem de capa (para SEO)"
}

Responda APENAS com o JSON, sem markdown code fence.`,
    }],
  })

  const text = (response.content[0] as { text: string }).text
  let parsed: { title: string; excerpt: string; content: string; imageAlt: string }

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim()
    parsed = JSON.parse(clean)
  } catch {
    return res.status(500).json({ error: 'Failed to parse AI response', raw: text.slice(0, 500) })
  }

  const slug = slugify(parsed.title) + '-' + Date.now().toString(36)
  const images = UNSPLASH_IMAGES[category] ?? UNSPLASH_IMAGES['dicas']
  const image = pickRandom(images)

  const post = await db.blogPost.create({
    data: {
      slug,
      title: parsed.title,
      excerpt: parsed.excerpt,
      content: parsed.content,
      category,
      image,
      imageAlt: parsed.imageAlt,
      author: 'Rookinho IA',
      published: true,
      source: 'ai-generated',
    },
  })

  // Send newsletter to all active subscribers
  let newsletterSent = 0
  try {
    const subscribers = await db.newsletterSubscriber.findMany({ where: { isActive: true } })
    const categoryLabels: Record<string, string> = {
      'dicas': 'Dicas', 'educacao-financeira': 'Educação Financeira',
      'investimentos': 'Investimentos', 'cripto': 'Cripto', 'curiosidades': 'Curiosidades',
    }
    for (const sub of subscribers) {
      await sendNewsletterEmail(sub.email, sub.unsubscribeToken, {
        title: post.title, excerpt: post.excerpt, slug: post.slug,
        image, category: categoryLabels[category] ?? category,
      }).catch(e => console.error(`[newsletter] failed for ${sub.email}:`, e))
      newsletterSent++
    }
  } catch (e) {
    console.error('[newsletter] fatal:', e)
  }

  return res.status(201).json({ ok: true, post: { id: post.id, slug: post.slug, title: post.title, category }, newsletterSent })
}
