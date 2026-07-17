// Detecção de títulos de blog do "mesmo tema" — fonte única, consumida pelo
// gerador (cron/blog-generate.ts) e pela data-migration que despublica clones.
// O blog foi reprovado no AdSense ("conteúdo de baixo valor") por artigos
// auto-gerados que repetiam o mesmo assunto (Bitcoin 3x, "curiosidades sobre
// dinheiro" 4x, CLT ou PJ 2x); isso mede essa repetição.

// Stopwords PT-BR pra não inflar a similaridade com palavras vazias.
const STOPWORDS = new Set([
  'o','a','os','as','de','do','da','dos','das','e','ou','que','com','em','no','na',
  'nos','nas','um','uma','uns','umas','para','por','pra','se','seu','sua','seus','suas',
  'você','voce','como','mais','menos','ao','à','é','não','nao','sem','sobre','ja','já',
  'agora','muito','vale','pena','isso','esse','essa','este','esta','qual','teste',
])

export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w)),
  )
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n
}

// Jaccard entre os conjuntos de palavras significativas dos títulos (0..1).
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a), tb = titleTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  const inter = intersectionSize(ta, tb)
  return inter / (ta.size + tb.size - inter)
}

// "Mesmo tema" = ou quase o mesmo título (Jaccard alto), ou as palavras-chave
// de um título são majoritariamente um subconjunto do outro (coeficiente de
// sobreposição alto), exigindo pelo menos 2 palavras significativas em comum
// pra não agrupar títulos que só dividem um substantivo genérico ("dinheiro").
export function sameTopic(a: string, b: string): boolean {
  const ta = titleTokens(a), tb = titleTokens(b)
  if (ta.size === 0 || tb.size === 0) return false
  const inter = intersectionSize(ta, tb)
  const jaccard = inter / (ta.size + tb.size - inter)
  const overlap = inter / Math.min(ta.size, tb.size)
  return jaccard >= 0.5 || (inter >= 2 && overlap >= 0.5)
}
