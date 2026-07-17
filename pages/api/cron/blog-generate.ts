import type { NextApiRequest, NextApiResponse } from 'next'
import Anthropic from '@anthropic-ai/sdk'
import { db } from '@/lib/db'
import { sendNewsletterEmail } from '@/lib/email'
import { trackCronRun } from '@/lib/cron-tracking'
import { sameTopic } from '@/lib/blog-dedup'

const UNSPLASH_IMAGES: Record<string, string[]> = {
  'dicas': [
    'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1586034679970-cb7b5fc4928a?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1518458028785-8b391fee5d17?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1532619675605-1ede6c2ed2b0?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1604594849809-dfedbc827105?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1200&h=630&fit=crop',
  ],
  'educacao-financeira': [
    'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1633158829585-23ba8f7c8caf?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1591696205602-2f950c417cb9?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1200&h=630&fit=crop',
  ],
  'investimentos': [
    'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1642790106117-e829e14a795f?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1535320903710-d993d3d77d29?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1560520653-9e0e4c89eb11?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1444653614773-995cb1ef9efa?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1559526324-593bc073d938?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1612010167108-3e6b327405f0?w=1200&h=630&fit=crop',
  ],
  'cripto': [
    'https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1621761191319-c6fb62004040?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1622630998477-20aa696ecb05?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1644143379190-07bf93901e74?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1516245834210-c4c142787335?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1629877521896-4719f02df3c6?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1640340434855-6084b1f4901c?w=1200&h=630&fit=crop',
  ],
  'curiosidades': [
    'https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1553729459-afe8f2e2ed65?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1580519542036-c47de6196ba5?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1567427017947-545c5f8d16ad?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1618044733300-9472054094ee?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1565514020179-026b92b84bb6?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=1200&h=630&fit=crop',
    'https://images.unsplash.com/photo-1633613286848-e6f43bbafb8d?w=1200&h=630&fit=crop',
  ],
}

const CATEGORIES = ['dicas', 'educacao-financeira', 'investimentos', 'cripto', 'curiosidades']

function pickRandom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

const UNSPLASH_SEARCH_TERMS: Record<string, string> = {
  'dicas': 'saving money personal finance',
  'educacao-financeira': 'financial education planning',
  'investimentos': 'stock market investment trading',
  'cripto': 'bitcoin cryptocurrency blockchain',
  'curiosidades': 'money economy world',
}

async function fetchUnsplashImage(category: string, recentImages: string[]): Promise<string | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY
  if (!accessKey) return null
  try {
    const query = UNSPLASH_SEARCH_TERMS[category] ?? 'finance money'
    const page = Math.floor(Math.random() * 5) + 1
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=10&page=${page}&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${accessKey}` }, signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) return null
    const data = await res.json()
    const photos = (data.results ?? []) as { urls: { regular: string } }[]
    const candidates = photos.filter(p => !recentImages.includes(p.urls.regular))
    const photo = candidates.length > 0 ? pickRandom(candidates) : photos[0]
    return photo?.urls?.regular ?? null
  } catch {
    return null
  }
}

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

  try {
    const { statusCode, body } = await trackCronRun('blog-generate', () => generateBlogPost())
    return res.status(statusCode).json(body)
  } catch (e) {
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

type BlogGenResult = { statusCode: number; body: Record<string, unknown> }

async function generateBlogPost(): Promise<BlogGenResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 503, body: { error: 'ANTHROPIC_API_KEY not configured' } }
  }

  // Check if already generated today — max 1 per day
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayCount = await db.blogPost.count({
    where: { source: 'ai-generated', createdAt: { gte: todayStart } },
  })
  if (todayCount >= 1) {
    return { statusCode: 200, body: { ok: true, skipped: true, reason: 'Already generated today' } }
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

  // Títulos já publicados — para o modelo NÃO repetir tema e para rejeitar duplicatas.
  const existingPosts = await db.blogPost.findMany({
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { title: true },
  })
  const existingTitles = existingPosts.map(p => p.title)
  const recentTitlesList = existingTitles.slice(0, 25).map(t => `- ${t}`).join('\n')

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const categoryLabel: Record<string, string> = {
    'dicas': 'dicas práticas de economia e organização financeira',
    'educacao-financeira': 'educação financeira (conceitos, estratégias, planejamento)',
    'investimentos': 'investimentos (renda fixa, variável, fundos, estratégias)',
    'cripto': 'criptomoedas e blockchain (Bitcoin, Ethereum, tendências, regulação)',
    'curiosidades': 'curiosidades sobre dinheiro, economia e finanças no Brasil e no mundo',
  }

  const buildPrompt = (extraWarning: string) => `Você é um redator especializado em finanças pessoais para o blog do Rook Money, um app brasileiro de controle financeiro.

DATA DE HOJE: ${new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })}. Quando mencionar o ano, use ${new Date().getFullYear()}.

CONTEXTO — Notícias da semana:
${trendingContext}

ARTIGOS JÁ PUBLICADOS (NÃO repita esses temas, ângulos ou títulos — escolha um assunto claramente diferente):
${recentTitlesList || '(nenhum ainda)'}
${extraWarning}
TAREFA: Escreva um artigo de blog sobre ${categoryLabel[category] ?? category}.

REGRAS DE ORIGINALIDADE (CRÍTICO — o blog foi reprovado no AdSense por conteúdo repetitivo):
- O tema DEVE ser diferente de todos os artigos da lista acima. Não basta trocar o número do título ("5 curiosidades" → "7 curiosidades") — o assunto tem que ser novo.
- Traga um ângulo específico, dado concreto, exemplo numérico real ou passo a passo acionável. Evite texto genérico que serve pra qualquer blog.

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

REGRAS DE TÍTULO:
- NÃO use "em ${new Date().getFullYear()}" no título — isso é genérico e repetitivo
- Crie títulos específicos, curiosos ou provocativos que gerem clique
- Bons exemplos: "Por Que Você Perde Dinheiro Sem Perceber", "O Método 50/30/20 Funciona no Brasil?", "Selic a X%: O Que Muda pro Seu Bolso"
- Maus exemplos: "Como Investir em 2026", "Organize suas Finanças em 2026", "Guia para Iniciantes em 2026"

FORMATO DE RESPOSTA (JSON):
{
  "title": "Título chamativo e específico (50-80 chars, SEM 'em ${new Date().getFullYear()}')",
  "excerpt": "Resumo de 1-2 frases (max 160 chars)",
  "content": "Conteúdo em Markdown com ## headings, listas, tabelas, blockquotes",
  "imageAlt": "Descrição da imagem de capa (para SEO)"
}

Responda APENAS com o JSON, sem markdown code fence.`

  // Título do "mesmo tema" (sameTopic) que um já publicado = duplicata → retry.
  let parsed: { title: string; excerpt: string; content: string; imageAlt: string } | null = null

  for (let attempt = 0; attempt < 3; attempt++) {
    const warning = attempt === 0
      ? ''
      : `\n⚠️ A tentativa anterior gerou um título parecido demais com um artigo já publicado. Escolha um TEMA totalmente diferente desta vez.\n`

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: buildPrompt(warning) }],
    })

    const text = (response.content[0] as { text: string }).text
    let candidate: { title: string; excerpt: string; content: string; imageAlt: string }
    try {
      const clean = text.replace(/```json\n?|\n?```/g, '').trim()
      candidate = JSON.parse(clean)
    } catch {
      if (attempt === 2) return { statusCode: 500, body: { error: 'Failed to parse AI response', raw: text.slice(0, 500) } }
      continue
    }

    const clash = existingTitles.find(t => sameTopic(candidate.title, t))
    if (!clash) { parsed = candidate; break }

    // Última tentativa ainda duplicada: pula o dia (melhor não publicar que publicar clone).
    if (attempt === 2) {
      return { statusCode: 200, body: { ok: true, skipped: true, reason: 'Todas as tentativas geraram título duplicado', lastTitle: candidate.title, clashWith: clash } }
    }
  }

  if (!parsed) {
    return { statusCode: 200, body: { ok: true, skipped: true, reason: 'Nenhum artigo único gerado' } }
  }

  const slug = slugify(parsed.title) + '-' + Date.now().toString(36)

  const recentPosts = await db.blogPost.findMany({
    where: { source: 'ai-generated' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { image: true },
  })
  const recentImages = recentPosts.map(p => p.image)

  const unsplashImage = await fetchUnsplashImage(category, recentImages)
  const fallbackImages = UNSPLASH_IMAGES[category] ?? UNSPLASH_IMAGES['dicas']
  const fallbackCandidates = fallbackImages.filter(img => !recentImages.includes(img))
  const image = unsplashImage ?? (fallbackCandidates.length > 0 ? pickRandom(fallbackCandidates) : pickRandom(fallbackImages))

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

  return { statusCode: 201, body: { ok: true, post: { id: post.id, slug: post.slug, title: post.title, category }, newsletterSent } }
}
