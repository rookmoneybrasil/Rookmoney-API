/**
 * Receipt parser using Google Gemini Flash Vision (free tier).
 * Sends a comprovante image and extracts transaction data.
 */

export interface ParsedReceipt {
  amount:      number
  date:        string       // YYYY-MM-DD
  description: string       // merchant / description (max 60 chars)
  type:        'INCOME' | 'EXPENSE'
  categoryId:  string | null
  confidence:  'high' | 'medium' | 'low'
}

export interface CategoryHint {
  id:   string
  name: string
  icon: string
}

export async function parseReceipt(
  imageBase64:  string,
  contentType:  string,
  categories:   CategoryHint[],
): Promise<ParsedReceipt> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')

  const today = new Date().toISOString().slice(0, 10)

  const categoryList = categories
    .map((c) => `${c.id} → ${c.icon} ${c.name}`)
    .join('\n')

  const prompt = `Você está analisando uma imagem de comprovante de pagamento, nota fiscal ou extrato financeiro brasileiro.

Extraia as informações abaixo e responda APENAS com JSON válido, sem markdown, sem texto extra.

Categorias disponíveis:
${categoryList}

Formato da resposta:
{
  "amount": <número decimal, ex: 47.90>,
  "date": "<YYYY-MM-DD, use ${today} se não encontrar>",
  "description": "<nome do estabelecimento ou descrição, máx 60 caracteres>",
  "type": "<EXPENSE para débitos/pagamentos, INCOME para créditos/depósitos/recebimentos>",
  "categoryId": "<id da categoria mais adequada ou null>",
  "confidence": "<high | medium | low>"
}

Regras:
- amount deve ser positivo, sem símbolo de moeda
- Se houver "CRÉDITO", "RECEBIDO", "PIX RECEBIDO" → type = INCOME
- Se houver "DÉBITO", "PAGO", "PIX ENVIADO", "COMPRA" → type = EXPENSE
- description deve ser o nome do estabelecimento ou pagador/recebedor
- Escolha a categoryId que melhor combina com o estabelecimento`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: contentType,
                data:      imageBase64,
              },
            },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature:     0.1,
          maxOutputTokens: 512,
        },
      }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Gemini API error: ${err?.error?.message ?? res.statusText}`)
  }

  const data = await res.json()
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'

  // Strip markdown code fences if present
  const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()

  let parsed: ParsedReceipt
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${cleaned.slice(0, 200)}`)
  }

  return {
    amount:      Math.abs(Number(parsed.amount ?? 0)),
    date:        parsed.date ?? today,
    description: String(parsed.description ?? 'Comprovante').slice(0, 60),
    type:        parsed.type === 'INCOME' ? 'INCOME' : 'EXPENSE',
    categoryId:  parsed.categoryId ?? null,
    confidence:  parsed.confidence ?? 'medium',
  }
}
