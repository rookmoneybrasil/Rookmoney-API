/**
 * Email sender using Resend API.
 * Env vars: RESEND_API_KEY, FROM_EMAIL
 */

async function resendPost(body: Record<string, unknown>): Promise<void> {
  const key = process.env.RESEND_API_KEY
  if (!key) { console.warn('[email] RESEND_API_KEY not set — skipping email'); return }

  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 10_000)
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  controller.signal,
  }).finally(() => clearTimeout(timeout))
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string }
    console.error('[email] Resend error:', err?.message)
  }
}

const FROM = process.env.FROM_EMAIL ?? 'Rook Money <noreply@rookmoney.com>'

export async function sendBillReminderEmail(
  to: string, name: string,
  bills: { name: string; amount: number; dueDate: Date }[],
): Promise<void> {
  const fmt = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`
  const rows = bills.map(b =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #1d3255">${b.name}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #1d3255;text-align:right;color:#f43f5e;font-weight:600">${fmt(b.amount)}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #1d3255;text-align:right;color:#94a3b8">${b.dueDate.toLocaleDateString('pt-BR')}</td></tr>`
  ).join('')

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `🔔 ${bills.length} conta${bills.length > 1 ? 's' : ''} venc${bills.length > 1 ? 'em' : 'e'} em 3 dias`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:32px;border-radius:16px">
  <h2 style="margin:0 0 8px;font-size:20px">Oi, ${name}! 👋</h2>
  <p style="color:#94a3b8;margin:0 0 24px">Você tem contas vencendo nos próximos 3 dias:</p>
  <table width="100%" cellpadding="0" cellspacing="0">
    <thead><tr>
      <th style="text-align:left;color:#64748b;font-size:11px;padding-bottom:8px">CONTA</th>
      <th style="text-align:right;color:#64748b;font-size:11px;padding-bottom:8px">VALOR</th>
      <th style="text-align:right;color:#64748b;font-size:11px;padding-bottom:8px">VENCIMENTO</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <a href="https://app.rookmoney.com/bills" style="display:inline-block;margin-top:24px;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Ver contas →</a>
  <p style="color:#475569;font-size:12px;margin-top:24px">Você recebe este aviso porque ativou lembretes de contas. <a href="https://app.rookmoney.com/settings" style="color:#60a5fa">Gerenciar preferências</a></p>
</div>`,
  })
}

export async function sendManualProExpiryWarningEmail(
  to: string, name: string, expiresAt: Date, daysLeft: number,
): Promise<void> {
  const dateStr = expiresAt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
  const isToday = daysLeft <= 0
  const subject = isToday
    ? '⚠️ Seu acesso PRO expira hoje'
    : `⏳ Seu acesso PRO expira em ${daysLeft} dia${daysLeft > 1 ? 's' : ''}`

  await resendPost({
    from: FROM,
    to:   [to],
    subject,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:32px;border-radius:16px">
  <h2 style="margin:0 0 8px;font-size:20px">Oi, ${name}! 👋</h2>
  <p style="color:#94a3b8;margin:0 0 24px">
    ${isToday
      ? 'Seu acesso PRO <strong style="color:#f1f5f9">expira hoje</strong>.'
      : `Seu acesso PRO expira em <strong style="color:#f1f5f9">${daysLeft} dia${daysLeft > 1 ? 's' : ''}</strong> (${dateStr}).`
    }
  </p>
  <p style="color:#94a3b8;margin:0 0 24px">Para continuar aproveitando todos os recursos PRO — relatórios avançados, metas ilimitadas, e muito mais — considere assinar o plano PRO.</p>
  <a href="https://app.rookmoney.com/settings/billing" style="display:inline-block;padding:12px 24px;background:#d97706;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Ver planos →</a>
  <p style="color:#475569;font-size:12px;margin-top:24px">Você recebeu este aviso porque possui acesso PRO no Rook Money.</p>
</div>`,
  })
}

export async function sendMonthlySummaryEmail(
  to: string, name: string,
  summary: { month: string; income: number; expense: number; balance: number; savingsRate: number },
): Promise<void> {
  const fmt  = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`
  const sign = summary.balance >= 0 ? '+' : ''
  const balColor = summary.balance >= 0 ? '#22c55e' : '#f43f5e'

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `📊 Resumo financeiro — ${summary.month}`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:32px;border-radius:16px">
  <h2 style="margin:0 0 4px;font-size:20px">Resumo de ${summary.month}</h2>
  <p style="color:#94a3b8;margin:0 0 24px">Oi ${name}, aqui está o seu resumo financeiro do mês passado.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px">
    <div style="background:#0c1628;border:1px solid #1d3255;border-radius:12px;padding:16px">
      <p style="color:#94a3b8;font-size:11px;margin:0 0 4px">RECEITAS</p>
      <p style="color:#22c55e;font-size:18px;font-weight:700;margin:0">+${fmt(summary.income)}</p>
    </div>
    <div style="background:#0c1628;border:1px solid #1d3255;border-radius:12px;padding:16px">
      <p style="color:#94a3b8;font-size:11px;margin:0 0 4px">DESPESAS</p>
      <p style="color:#f43f5e;font-size:18px;font-weight:700;margin:0">-${fmt(summary.expense)}</p>
    </div>
    <div style="background:#0c1628;border:1px solid #1d3255;border-radius:12px;padding:16px">
      <p style="color:#94a3b8;font-size:11px;margin:0 0 4px">SALDO</p>
      <p style="color:${balColor};font-size:18px;font-weight:700;margin:0">${sign}${fmt(summary.balance)}</p>
    </div>
  </div>
  ${summary.savingsRate >= 0 ? `<p style="color:#94a3b8">Taxa de poupança: <strong style="color:#f1f5f9">${summary.savingsRate}%</strong></p>` : ''}
  <a href="https://app.rookmoney.com/reports" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Ver relatórios completos →</a>
  <p style="color:#475569;font-size:12px;margin-top:24px">Você recebe este resumo todo dia 1. <a href="https://app.rookmoney.com/settings" style="color:#60a5fa">Desativar</a></p>
</div>`,
  })
}

export async function sendPaymentFailedEmail(
  to: string, name: string,
): Promise<void> {
  await resendPost({
    from:    FROM,
    to:      [to],
    subject: '⚠️ Problema com o pagamento da sua assinatura PRO',
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:32px;border-radius:16px">
  <h2 style="margin:0 0 8px;font-size:20px">Oi, ${name}! 👋</h2>
  <p style="color:#94a3b8;margin:0 0 24px">Houve um problema ao processar o pagamento da sua assinatura PRO. Atualize sua forma de pagamento para evitar a perda do acesso.</p>
  <a href="https://app.rookmoney.com/billing" style="display:inline-block;padding:12px 24px;background:#d97706;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Atualizar pagamento →</a>
  <p style="color:#475569;font-size:12px;margin-top:24px">Se você já resolveu, pode ignorar este e-mail.</p>
</div>`,
  })
}

export async function sendNewsletterEmail(
  to: string,
  unsubscribeToken: string,
  post: { title: string; excerpt: string; slug: string; image: string; category: string },
): Promise<void> {
  const unsubUrl = `https://rookmoney-api-production.up.railway.app/api/v1/newsletter/unsubscribe?token=${unsubscribeToken}`
  const postUrl = `https://rookmoney.com/blog/${post.slug}`

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `📰 ${post.title}`,
    headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
    html: `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <img src="${post.image}" alt="${post.title}" style="width:100%;height:200px;object-fit:cover" />
  <div style="padding:24px 32px 32px">
    <span style="display:inline-block;font-size:11px;font-weight:600;color:#3b82f6;text-transform:uppercase;margin-bottom:8px">${post.category}</span>
    <h2 style="margin:0 0 12px;font-size:22px;line-height:1.3"><a href="${postUrl}" style="color:#f1f5f9;text-decoration:none">${post.title}</a></h2>
    <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">${post.excerpt}</p>
    <a href="${postUrl}" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Ler artigo completo →</a>
    <hr style="border:none;border-top:1px solid #1e293b;margin:28px 0 16px" />
    <p style="color:#475569;font-size:11px;margin:0;text-align:center">
      Você recebeu este email porque se inscreveu na newsletter do Rook Money.<br/>
      <a href="${unsubUrl}" style="color:#60a5fa">Cancelar inscrição</a>
    </p>
  </div>
</div>`,
  })
}

export async function sendChurnAlertEmail(
  to: string, churnCount: number, threshold: number, month: string,
): Promise<void> {
  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `⚠️ Alerta de churn: ${churnCount} downgrades em ${month}`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:32px;border-radius:16px">
  <h2 style="margin:0 0 8px;font-size:20px;color:#f43f5e">⚠️ Alerta de Churn</h2>
  <p style="color:#94a3b8;margin:0 0 24px">O churn em <strong style="color:#f1f5f9">${month}</strong> ultrapassou o limite configurado.</p>
  <div style="background:#0c1628;border:1px solid #3b1111;border-radius:12px;padding:20px;margin-bottom:24px">
    <p style="margin:0 0 8px;color:#94a3b8;font-size:12px">DOWNGRADES NO MÊS</p>
    <p style="margin:0;font-size:32px;font-weight:700;color:#f43f5e">${churnCount}</p>
    <p style="margin:4px 0 0;font-size:12px;color:#475569">Limite configurado: ${threshold}</p>
  </div>
  <a href="https://rookmoney-backoffice.vercel.app/reports" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Ver relatório de churn →</a>
  <p style="color:#475569;font-size:12px;margin-top:24px">Ajuste o limite em <a href="https://rookmoney-backoffice.vercel.app/settings" style="color:#60a5fa">Configurações</a> do backoffice.</p>
</div>`,
  })
}
