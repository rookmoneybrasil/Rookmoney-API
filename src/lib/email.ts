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

export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  const firstName = name.split(' ')[0]

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: 'Bem-vindo ao Rook Money! 🎉',
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#0d1b3e 0%,#1a1040 100%);padding:40px 32px 24px;text-align:center">
    <img src="https://rookmoney.com/rookinho.png" alt="Rookinho" width="120" height="120" style="display:inline-block;object-fit:contain" />
    <h1 style="color:#f1f5f9;margin:16px 0 0;font-size:24px;font-weight:700">Fala, ${firstName}! 👋</h1>
    <p style="color:#94a3b8;margin:8px 0 0;font-size:15px">Sua conta no Rook Money foi criada com sucesso.</p>
  </div>

  <div style="padding:32px">
    <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
      Eu sou o <strong style="color:#f1f5f9">Rookinho</strong>, seu assistente financeiro. Vou te ajudar a organizar suas finanças de um jeito simples e sem dor de cabeça.
    </p>

    <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 12px;font-weight:600">O que você pode fazer</p>

    <div style="margin-bottom:24px">
      <div style="display:flex;align-items:flex-start;margin-bottom:12px">
        <span style="color:#3b82f6;font-size:18px;margin-right:12px;line-height:1">📊</span>
        <div>
          <p style="margin:0;color:#f1f5f9;font-size:14px;font-weight:600">Dashboard completo</p>
          <p style="margin:2px 0 0;color:#64748b;font-size:13px">Visão geral das suas receitas, despesas e saldo</p>
        </div>
      </div>
      <div style="display:flex;align-items:flex-start;margin-bottom:12px">
        <span style="color:#22c55e;font-size:18px;margin-right:12px;line-height:1">💰</span>
        <div>
          <p style="margin:0;color:#f1f5f9;font-size:14px;font-weight:600">Contas e rendas</p>
          <p style="margin:2px 0 0;color:#64748b;font-size:13px">Controle contas a pagar, parcelas e fontes de renda</p>
        </div>
      </div>
      <div style="display:flex;align-items:flex-start;margin-bottom:12px">
        <span style="color:#a855f7;font-size:18px;margin-right:12px;line-height:1">🎯</span>
        <div>
          <p style="margin:0;color:#f1f5f9;font-size:14px;font-weight:600">Metas financeiras</p>
          <p style="margin:2px 0 0;color:#64748b;font-size:13px">Defina objetivos e acompanhe seu progresso</p>
        </div>
      </div>
      <div style="display:flex;align-items:flex-start">
        <span style="color:#f59e0b;font-size:18px;margin-right:12px;line-height:1">🤖</span>
        <div>
          <p style="margin:0;color:#f1f5f9;font-size:14px;font-weight:600">Rookinho IA</p>
          <p style="margin:2px 0 0;color:#64748b;font-size:13px">Converse com a IA sobre suas finanças (PRO)</p>
        </div>
      </div>
    </div>

    <a href="https://app.rookmoney.com" style="display:block;text-align:center;padding:14px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Acessar meu dashboard →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      Você recebeu este e-mail porque criou uma conta no <a href="https://rookmoney.com" style="color:#60a5fa;text-decoration:none">Rook Money</a>.
    </p>
  </div>
</div>`,
  })
}

export async function sendAccountDeletedEmail(
  to: string,
  name: string,
  opts?: { planCancelled?: boolean; planName?: string },
): Promise<void> {
  const firstName = (name || '').split(' ')[0] || 'você'
  const planCancelled = opts?.planCancelled ?? false
  const planName = opts?.planName ?? 'PRO'

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: 'Sua conta no Rook Money foi excluída',
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#0d1b3e 0%,#1a1040 100%);padding:40px 32px 24px;text-align:center">
    <img src="https://rookmoney.com/rookinho.png" alt="Rookinho" width="110" height="110" style="display:inline-block;object-fit:contain" />
    <h1 style="color:#f1f5f9;margin:16px 0 0;font-size:22px;font-weight:700">Até logo, ${firstName} 👋</h1>
    <p style="color:#94a3b8;margin:8px 0 0;font-size:15px">Sua conta foi excluída conforme solicitado.</p>
  </div>

  <div style="padding:32px">
    <p style="color:#94a3b8;margin:0 0 20px;font-size:15px;line-height:1.6">
      Confirmamos que sua conta no <strong style="color:#f1f5f9">Rook Money</strong> e todos os seus dados foram
      <strong style="color:#f1f5f9">excluídos permanentemente</strong>. Não é possível recuperá-los.
    </p>

    ${planCancelled ? `
    <div style="background:#0d1b3e;border:1px solid #1e2d4a;border-radius:12px;padding:16px;margin-bottom:20px">
      <p style="margin:0;color:#f1f5f9;font-size:14px;font-weight:600">✅ Assinatura ${planName} cancelada</p>
      <p style="margin:6px 0 0;color:#94a3b8;font-size:13px;line-height:1.5">
        Sua assinatura foi cancelada e <strong style="color:#cbd5e1">você não será cobrado novamente</strong>.
        Eventuais cobranças já realizadas não são reembolsadas automaticamente.
      </p>
    </div>` : ''}

    <p style="color:#64748b;margin:0 0 24px;font-size:14px;line-height:1.6">
      Se mudou de ideia, você é sempre bem-vindo de volta — é só criar uma nova conta quando quiser. 🐂
    </p>

    <a href="https://rookmoney.com" style="display:block;text-align:center;padding:13px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Voltar para o Rook Money</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      Você recebeu este e-mail porque excluiu sua conta no <a href="https://rookmoney.com" style="color:#60a5fa;text-decoration:none">Rook Money</a>.
      Se você não fez essa solicitação, entre em contato conosco imediatamente.
    </p>
  </div>
</div>`,
  })
}

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

export async function sendUpgradeEmail(
  to: string, name: string, plan: 'PRO' | 'PRO_PLUS',
): Promise<void> {
  const firstName = name.split(' ')[0]
  const planLabel = plan === 'PRO_PLUS' ? 'PRO+' : 'PRO'
  const price = plan === 'PRO_PLUS' ? 'R$ 34,90' : 'R$ 19,90'

  const features = plan === 'PRO_PLUS'
    ? [
        { icon: '🤖', title: 'Rookinho IA ilimitado', desc: 'Converse com a IA sobre suas finanças sem limites' },
        { icon: '📊', title: 'Relatórios avançados', desc: 'Análises detalhadas e gráficos personalizados' },
        { icon: '🎯', title: 'Metas ilimitadas', desc: 'Crie quantas metas quiser sem restrição' },
        { icon: '⭐', title: 'Tudo do PRO + extras', desc: 'Todas as funcionalidades PRO e mais' },
      ]
    : [
        { icon: '📊', title: 'Relatórios avançados', desc: 'Análises detalhadas e gráficos personalizados' },
        { icon: '🎯', title: 'Metas ilimitadas', desc: 'Crie quantas metas quiser sem restrição' },
        { icon: '🤖', title: 'Rookinho IA', desc: '30 mensagens/mês com o assistente financeiro' },
        { icon: '🔔', title: 'Lembretes de contas', desc: 'Receba avisos antes das contas vencerem' },
      ]

  const featureRows = features.map(f =>
    `<tr><td style="padding:8px 0;vertical-align:top;width:30px"><span style="font-size:16px">${f.icon}</span></td>` +
    `<td style="padding:8px 0;padding-left:12px"><strong style="color:#f1f5f9;font-size:14px">${f.title}</strong>` +
    `<br/><span style="color:#64748b;font-size:13px">${f.desc}</span></td></tr>`
  ).join('')

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `Bem-vindo ao ${planLabel}! 🚀`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%);padding:40px 32px;text-align:center">
    <div style="display:inline-block;background:#4f46e5;color:#fff;font-size:12px;font-weight:700;padding:4px 14px;border-radius:20px;letter-spacing:0.05em;margin-bottom:16px">${planLabel}</div>
    <h1 style="color:#f1f5f9;margin:0;font-size:24px;font-weight:700">Parabéns, ${firstName}! 🎉</h1>
    <p style="color:#c4b5fd;margin:8px 0 0;font-size:15px">Seu plano ${planLabel} (${price}/mês) já está ativo.</p>
  </div>

  <div style="padding:32px">
    <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 16px;font-weight:600">Agora você tem acesso a</p>
    <table cellpadding="0" cellspacing="0" width="100%">${featureRows}</table>

    <a href="https://app.rookmoney.com" style="display:block;text-align:center;margin-top:28px;padding:14px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Explorar recursos ${planLabel} →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      Gerencie sua assinatura em <a href="https://app.rookmoney.com/settings/billing" style="color:#60a5fa;text-decoration:none">Configurações</a>.
    </p>
  </div>
</div>`,
  })
}

export async function sendDowngradeEmail(
  to: string, name: string, previousPlan: string,
): Promise<void> {
  const firstName = name.split(' ')[0]
  const planLabel = previousPlan === 'PRO_PLUS' ? 'PRO+' : 'PRO'

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `Sua assinatura ${planLabel} foi encerrada`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="padding:40px 32px 24px;text-align:center">
    <img src="https://rookmoney.com/rookinho.png" alt="Rookinho" width="100" height="100" style="display:inline-block;object-fit:contain;opacity:0.8" />
    <h2 style="color:#f1f5f9;margin:16px 0 0;font-size:22px;font-weight:700">Sentiremos sua falta, ${firstName}</h2>
    <p style="color:#94a3b8;margin:8px 0 0;font-size:15px">Sua assinatura ${planLabel} foi encerrada.</p>
  </div>

  <div style="padding:0 32px 32px">
    <div style="background:#0c1628;border:1px solid #1e2d4a;border-radius:12px;padding:20px;margin-bottom:24px">
      <p style="margin:0 0 8px;color:#94a3b8;font-size:14px;line-height:1.6">
        Sua conta continua ativa no plano <strong style="color:#f1f5f9">FREE</strong>. Você ainda pode:
      </p>
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.8">
        • Registrar transações e contas<br/>
        • Acompanhar seu dashboard<br/>
        • Usar o orçamento mensal
      </p>
    </div>

    <p style="color:#94a3b8;margin:0 0 24px;font-size:14px;line-height:1.6">
      Se mudou de ideia, você pode voltar ao ${planLabel} a qualquer momento — seus dados estão seguros.
    </p>

    <a href="https://app.rookmoney.com/settings/billing" style="display:block;text-align:center;padding:14px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Reativar meu plano →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      Você recebeu este e-mail porque sua assinatura ${planLabel} no <a href="https://rookmoney.com" style="color:#60a5fa;text-decoration:none">Rook Money</a> foi encerrada.
    </p>
  </div>
</div>`,
  })
}

export async function sendInactivityEmail(
  to: string, name: string, daysSince: number,
): Promise<void> {
  const firstName = name.split(' ')[0]

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `${firstName}, faz ${daysSince} dias que não te vemos 😢`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#0d1b3e 0%,#1a1040 100%);padding:40px 32px;text-align:center">
    <img src="https://rookmoney.com/rookinho.png" alt="Rookinho" width="100" height="100" style="display:inline-block;object-fit:contain;opacity:0.7" />
    <h2 style="color:#f1f5f9;margin:16px 0 0;font-size:22px;font-weight:700">Oi ${firstName}, cadê você?</h2>
    <p style="color:#94a3b8;margin:8px 0 0;font-size:15px">Faz ${daysSince} dias que você não aparece por aqui.</p>
  </div>

  <div style="padding:32px">
    <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
      O Rookinho tá sentindo sua falta! Suas finanças não param enquanto você está fora — contas vencem, gastos acontecem.
    </p>

    <div style="background:#0c1628;border:1px solid #1e2d4a;border-radius:12px;padding:20px;margin-bottom:24px">
      <p style="margin:0;color:#94a3b8;font-size:14px;line-height:1.8">
        <strong style="color:#f1f5f9">Que tal em 2 minutinhos:</strong><br/>
        • Registrar os gastos dos últimos dias<br/>
        • Verificar se tem conta vencendo<br/>
        • Conferir como está seu orçamento
      </p>
    </div>

    <a href="https://app.rookmoney.com" style="display:block;text-align:center;padding:14px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Voltar pro dashboard →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      <a href="https://app.rookmoney.com/settings" style="color:#60a5fa;text-decoration:none">Gerenciar notificações</a>
    </p>
  </div>
</div>`,
  })
}

export async function sendGoalCompletedEmail(
  to: string, name: string, goalName: string, targetAmount: number,
): Promise<void> {
  const firstName = name.split(' ')[0]
  const fmtAmount = `R$ ${targetAmount.toFixed(2).replace('.', ',')}`

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `Meta "${goalName}" atingida! 🎉`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#064e3b 0%,#065f46 100%);padding:40px 32px;text-align:center">
    <div style="font-size:48px;margin-bottom:12px">🎯</div>
    <h1 style="color:#f1f5f9;margin:0;font-size:24px;font-weight:700">Meta atingida!</h1>
    <p style="color:#6ee7b7;margin:8px 0 0;font-size:15px">Parabéns, ${firstName}!</p>
  </div>

  <div style="padding:32px">
    <div style="background:#0c1628;border:1px solid #1e2d4a;border-radius:12px;padding:24px;margin-bottom:24px;text-align:center">
      <p style="margin:0 0 4px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:0.05em">META CONCLUÍDA</p>
      <p style="margin:0 0 8px;color:#f1f5f9;font-size:20px;font-weight:700">${goalName}</p>
      <p style="margin:0;color:#22c55e;font-size:24px;font-weight:700">${fmtAmount}</p>
    </div>

    <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
      Você mostrou disciplina e comprometimento. Isso é incrível! Que tal definir uma nova meta e continuar evoluindo?
    </p>

    <a href="https://app.rookmoney.com/goals" style="display:block;text-align:center;padding:14px 28px;background:#059669;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Ver minhas metas →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      Continue acompanhando suas finanças no <a href="https://rookmoney.com" style="color:#60a5fa;text-decoration:none">Rook Money</a>.
    </p>
  </div>
</div>`,
  })
}

export async function sendAchievementEmail(
  to: string, name: string, achievementTitle: string, achievementIcon: string,
): Promise<void> {
  const firstName = name.split(' ')[0]

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `Conquista desbloqueada: ${achievementTitle} ${achievementIcon}`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#78350f 0%,#92400e 100%);padding:40px 32px;text-align:center">
    <div style="font-size:56px;margin-bottom:8px">${achievementIcon}</div>
    <h1 style="color:#f1f5f9;margin:0;font-size:22px;font-weight:700">Conquista desbloqueada!</h1>
    <p style="color:#fbbf24;margin:8px 0 0;font-size:16px;font-weight:600">${achievementTitle}</p>
  </div>

  <div style="padding:32px">
    <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
      Parabéns, ${firstName}! Você desbloqueou uma nova conquista no Rook Money. Continue usando a plataforma para desbloquear mais!
    </p>

    <a href="https://app.rookmoney.com/achievements" style="display:block;text-align:center;padding:14px 28px;background:#d97706;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Ver todas as conquistas →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      <a href="https://app.rookmoney.com/settings" style="color:#60a5fa;text-decoration:none">Gerenciar notificações</a>
    </p>
  </div>
</div>`,
  })
}

export async function sendDripOnboardingEmail(
  to: string, name: string, day: 1 | 3 | 7,
): Promise<void> {
  const firstName = name.split(' ')[0]

  const content: Record<1 | 3 | 7, { subject: string; heading: string; body: string; cta: string; ctaUrl: string }> = {
    1: {
      subject: `${firstName}, já registrou seu primeiro gasto?`,
      heading: 'Bora começar!',
      body: 'O primeiro passo pra organizar suas finanças é registrar seus gastos. Leva menos de 1 minuto — e o Rookinho te ajuda no caminho.',
      cta: 'Registrar meu primeiro gasto →',
      ctaUrl: 'https://app.rookmoney.com/transactions',
    },
    3: {
      subject: `${firstName}, já definiu uma meta financeira?`,
      heading: 'Que tal uma meta?',
      body: 'Viagem, celular novo, reserva de emergência... Definir uma meta te dá um norte. E no Rook Money você acompanha cada aporte até chegar lá.',
      cta: 'Criar minha primeira meta →',
      ctaUrl: 'https://app.rookmoney.com/goals',
    },
    7: {
      subject: `${firstName}, conheça o Rookinho IA 🤖`,
      heading: 'Seu assistente financeiro',
      body: 'O Rookinho IA analisa seus gastos, responde dúvidas, cria transações por você e até lê extratos bancários. Tudo por conversa, como um amigo que entende de dinheiro.',
      cta: 'Conversar com o Rookinho →',
      ctaUrl: 'https://app.rookmoney.com/chat',
    },
  }

  const c = content[day]

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: c.subject,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="padding:40px 32px 24px;text-align:center">
    <img src="https://rookmoney.com/rookinho.png" alt="Rookinho" width="100" height="100" style="display:inline-block;object-fit:contain" />
    <h2 style="color:#f1f5f9;margin:16px 0 0;font-size:22px;font-weight:700">${c.heading}</h2>
  </div>

  <div style="padding:0 32px 32px">
    <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">${c.body}</p>

    <a href="${c.ctaUrl}" style="display:block;text-align:center;padding:14px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">${c.cta}</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      Dica ${day}/3 do onboarding · <a href="https://app.rookmoney.com/settings" style="color:#60a5fa;text-decoration:none">Gerenciar notificações</a>
    </p>
  </div>
</div>`,
  })
}

export async function sendAnniversaryEmail(
  to: string, name: string, years: number,
): Promise<void> {
  const firstName = name.split(' ')[0]
  const label = years === 1 ? '1 ano' : `${years} anos`

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `${label} de Rook Money! 🎂`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#312e81 0%,#4c1d95 100%);padding:40px 32px;text-align:center">
    <div style="font-size:48px;margin-bottom:12px">🎂</div>
    <h1 style="color:#f1f5f9;margin:0;font-size:24px;font-weight:700">Feliz aniversário, ${firstName}!</h1>
    <p style="color:#c4b5fd;margin:8px 0 0;font-size:15px">Hoje faz ${label} que você está no Rook Money.</p>
  </div>

  <div style="padding:32px">
    <p style="color:#94a3b8;margin:0 0 24px;font-size:15px;line-height:1.6">
      Obrigado por confiar no Rook Money para organizar suas finanças. Cada transação registrada, cada meta atingida, cada conta paga em dia — tudo isso é mérito seu. O Rookinho só ajudou um pouquinho. 😄
    </p>

    <a href="https://app.rookmoney.com" style="display:block;text-align:center;padding:14px 28px;background:#7c3aed;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Continuar evoluindo →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      Obrigado por fazer parte do <a href="https://rookmoney.com" style="color:#60a5fa;text-decoration:none">Rook Money</a>. 💜
    </p>
  </div>
</div>`,
  })
}

export async function sendFreeToProEmail(
  to: string, name: string, day: 14 | 30 | 60,
  stats?: { transactions?: number; bills?: number; goals?: number },
): Promise<void> {
  const firstName = name.split(' ')[0]

  const content: Record<14 | 30 | 60, { subject: string; heading: string; body: string; highlight: string }> = {
    14: {
      subject: `${firstName}, você está usando só metade do Rook Money`,
      heading: 'Desbloqueie o potencial completo',
      body: 'Você já deu os primeiros passos — registrou gastos, acompanhou contas. Mas no plano gratuito, você tá usando só uma fração do que o Rook Money oferece.',
      highlight: 'Quem assina o PRO consegue controlar até 3x mais do que no gratuito.',
    },
    30: {
      subject: `${firstName}, 1 mês de Rook Money — e agora?`,
      heading: 'Seu primeiro mês completo!',
      body: stats && (stats.transactions ?? 0) > 0
        ? `Em 30 dias você registrou ${stats.transactions} transação${(stats.transactions ?? 0) !== 1 ? 'ões' : ''}, ${stats.bills ?? 0} conta${(stats.bills ?? 0) !== 1 ? 's' : ''} e ${stats.goals ?? 0} meta${(stats.goals ?? 0) !== 1 ? 's' : ''}. Imagina o que você faria com relatórios avançados, Rookinho IA e metas ilimitadas?`
        : 'Faz 1 mês que você criou sua conta. No plano PRO, você tem relatórios avançados, metas ilimitadas e o Rookinho IA pra te ajudar a organizar tudo.',
      highlight: 'R$ 19,90/mês = R$ 0,66/dia. Menos que um café.',
    },
    60: {
      subject: `${firstName}, o PRO foi feito pra quem já usa o Rook Money`,
      heading: 'Você já provou que leva a sério',
      body: '2 meses usando o Rook Money é sinal de compromisso. Quem chega até aqui no gratuito normalmente fica frustrado com os limites — e quem assina não volta atrás.',
      highlight: 'O PRO+ ainda tem IA ilimitada por R$ 34,90/mês.',
    },
  }

  const c = content[day]

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: c.subject,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%);padding:40px 32px;text-align:center">
    <img src="https://rookmoney.com/rookinho.png" alt="Rookinho" width="100" height="100" style="display:inline-block;object-fit:contain" />
    <h1 style="color:#f1f5f9;margin:16px 0 0;font-size:22px;font-weight:700">${c.heading}</h1>
  </div>

  <div style="padding:32px">
    <p style="color:#94a3b8;margin:0 0 20px;font-size:15px;line-height:1.6">${c.body}</p>

    <div style="background:#0c1628;border:1px solid #1e2d4a;border-radius:12px;padding:20px;margin-bottom:24px">
      <p style="margin:0;color:#c4b5fd;font-size:14px;font-weight:600;line-height:1.5">${c.highlight}</p>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:24px">
      <div style="flex:1;background:#0c1628;border:1px solid #4f46e5;border-radius:12px;padding:16px;text-align:center">
        <p style="margin:0;color:#818cf8;font-size:11px;font-weight:600">PRO</p>
        <p style="margin:4px 0 0;color:#f1f5f9;font-size:20px;font-weight:700">R$ 19,90</p>
        <p style="margin:2px 0 0;color:#64748b;font-size:12px">/mês</p>
      </div>
      <div style="flex:1;background:#0c1628;border:1px solid #7c3aed;border-radius:12px;padding:16px;text-align:center">
        <p style="margin:0;color:#a78bfa;font-size:11px;font-weight:600">PRO+</p>
        <p style="margin:4px 0 0;color:#f1f5f9;font-size:20px;font-weight:700">R$ 34,90</p>
        <p style="margin:2px 0 0;color:#64748b;font-size:12px">/mês · IA ilimitada</p>
      </div>
    </div>

    <a href="https://app.rookmoney.com/settings/billing" style="display:block;text-align:center;padding:14px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Ver planos PRO →</a>

    <table cellpadding="0" cellspacing="0" width="100%" style="margin-top:24px">
      <tr>
        <td style="padding:6px 0;color:#94a3b8;font-size:13px">✓ Relatórios avançados</td>
        <td style="padding:6px 0;color:#94a3b8;font-size:13px;text-align:right">✓ Metas ilimitadas</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#94a3b8;font-size:13px">✓ Rookinho IA</td>
        <td style="padding:6px 0;color:#94a3b8;font-size:13px;text-align:right">✓ Lembretes por email</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#94a3b8;font-size:13px">✓ Contas ilimitadas</td>
        <td style="padding:6px 0;color:#94a3b8;font-size:13px;text-align:right">✓ Orçamento completo</td>
      </tr>
    </table>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      <a href="https://app.rookmoney.com/settings" style="color:#60a5fa;text-decoration:none">Gerenciar notificações</a>
    </p>
  </div>
</div>`,
  })
}

export async function sendAnnualUpsellEmail(
  to: string, name: string, plan: string, monthsActive: number,
): Promise<void> {
  const firstName = name.split(' ')[0]
  const planLabel = plan === 'PRO_PLUS' ? 'PRO+' : 'PRO'
  const monthlyPrice = plan === 'PRO_PLUS' ? 34.90 : 19.90
  const annualMonthly = plan === 'PRO_PLUS' ? 29.08 : 16.58
  const savings = Math.round((monthlyPrice - annualMonthly) * 12)

  await resendPost({
    from:    FROM,
    to:      [to],
    subject: `${firstName}, economize R$ ${savings} no plano anual 💰`,
    html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#080e1d;color:#f1f5f9;padding:0;border-radius:16px;overflow:hidden">
  <div style="padding:40px 32px 24px;text-align:center">
    <div style="display:inline-block;background:#4f46e5;color:#fff;font-size:12px;font-weight:700;padding:4px 14px;border-radius:20px;letter-spacing:0.05em;margin-bottom:16px">${planLabel} ANUAL</div>
    <h2 style="color:#f1f5f9;margin:0;font-size:22px;font-weight:700">Economize no plano anual</h2>
    <p style="color:#94a3b8;margin:8px 0 0;font-size:15px">Você já é ${planLabel} há ${monthsActive} meses — tá na hora de economizar!</p>
  </div>

  <div style="padding:0 32px 32px">
    <div style="display:flex;gap:12px;margin-bottom:24px">
      <div style="flex:1;background:#0c1628;border:1px solid #1e2d4a;border-radius:12px;padding:16px;text-align:center">
        <p style="margin:0 0 4px;color:#94a3b8;font-size:11px">MENSAL</p>
        <p style="margin:0;color:#64748b;font-size:18px;font-weight:700;text-decoration:line-through">R$ ${monthlyPrice.toFixed(2).replace('.', ',')}</p>
        <p style="margin:2px 0 0;color:#64748b;font-size:12px">/mês</p>
      </div>
      <div style="flex:1;background:#0c1628;border:2px solid #4f46e5;border-radius:12px;padding:16px;text-align:center">
        <p style="margin:0 0 4px;color:#818cf8;font-size:11px;font-weight:600">ANUAL</p>
        <p style="margin:0;color:#f1f5f9;font-size:18px;font-weight:700">R$ ${annualMonthly.toFixed(2).replace('.', ',')}</p>
        <p style="margin:2px 0 0;color:#22c55e;font-size:12px;font-weight:600">Economize R$ ${savings}</p>
      </div>
    </div>

    <a href="https://app.rookmoney.com/settings/billing" style="display:block;text-align:center;padding:14px 28px;background:#4f46e5;color:#fff;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none">Mudar para anual →</a>
  </div>

  <div style="padding:20px 32px;border-top:1px solid #1e2d4a;background:#060a16">
    <p style="margin:0;font-size:12px;color:#334155;text-align:center">
      <a href="https://app.rookmoney.com/settings" style="color:#60a5fa;text-decoration:none">Gerenciar assinatura</a>
    </p>
  </div>
</div>`,
  })
}
