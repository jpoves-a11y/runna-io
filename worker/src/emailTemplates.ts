// Emails of Runna.io: one minimal layout for all of them, in HTML and plain text.
//
// The HTML is built for email clients, not browsers: tables and inline styles (Gmail ignores grid
// and gradients), every block sets both its background and its text colour, and a dark version is
// declared (color-scheme + prefers-color-scheme + Outlook's [data-ogsc]) so a light text never ends
// up on a light background. No images, no emoji in subjects, no tracking pixels: plain, readable
// emails get to the inbox more often.

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailLayout {
  /** Text shown next to the subject in the inbox (hidden in the body) */
  preheader: string;
  heading: string;
  /** Plain-text paragraphs; **words** are bold */
  paragraphs: string[];
  /** Numbered steps */
  steps?: string[];
  /** One-time code in a big box */
  code?: string;
  codeNote?: string;
  /** Label / value rows (report details) */
  details?: Array<[string, string]>;
  cta?: { label: string; url: string };
  /** Line after the button, before the signature */
  closing?: string;
  /** Why this email arrives (footer) */
  reason: string;
  /** Link to stop these emails (not on account emails such as codes) */
  unsubscribeUrl?: string;
  /** Worker URL, for the privacy link */
  baseUrl: string;
  supportEmail: string;
}

const LIGHT = {
  page: '#F3F4F6',
  card: '#FFFFFF',
  text: '#111418',
  muted: '#5B6470',
  faint: '#8A929C',
  line: '#E5E7EB',
  brand: '#0E8A5F',
  buttonText: '#FFFFFF',
  codeBg: '#F3F7F5',
};

const DARK = {
  page: '#0B0D10',
  card: '#16191D',
  text: '#F2F4F6',
  muted: '#A3ABB5',
  faint: '#7D858F',
  line: '#2A2F35',
  brand: '#3CC98E',
  buttonText: '#04241A',
  codeBg: '#1D2622',
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;

export function escapeEmail(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes a paragraph and turns **words** into bold. */
function richText(value: string): string {
  return escapeEmail(value).replace(/\*\*(.+?)\*\*/g, `<strong class="txt" style="color:${LIGHT.text};font-weight:600;">$1</strong>`);
}

const plain = (value: string) => value.replace(/\*\*(.+?)\*\*/g, '$1');

const STYLE = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { text-decoration:none; }
  @media (prefers-color-scheme: dark) {
    .page { background:${DARK.page} !important; }
    .card { background:${DARK.card} !important; border-color:${DARK.line} !important; }
    .txt { color:${DARK.text} !important; }
    .muted { color:${DARK.muted} !important; }
    .faint, .faint a { color:${DARK.faint} !important; }
    .brand { color:${DARK.brand} !important; }
    .line { border-color:${DARK.line} !important; }
    .btn { background:${DARK.brand} !important; }
    .btn a { color:${DARK.buttonText} !important; }
    .code { background:${DARK.codeBg} !important; border-color:${DARK.line} !important; color:${DARK.text} !important; }
    .num { background:${DARK.brand} !important; color:${DARK.buttonText} !important; }
  }
  [data-ogsc] .page { background:${DARK.page} !important; }
  [data-ogsc] .card { background:${DARK.card} !important; }
  [data-ogsc] .txt { color:${DARK.text} !important; }
  [data-ogsc] .muted { color:${DARK.muted} !important; }
  [data-ogsc] .faint { color:${DARK.faint} !important; }
  [data-ogsc] .brand { color:${DARK.brand} !important; }
  [data-ogsc] .btn { background:${DARK.brand} !important; }
  [data-ogsc] .btn a { color:${DARK.buttonText} !important; }
  [data-ogsc] .code { background:${DARK.codeBg} !important; color:${DARK.text} !important; }
  @media (max-width: 600px) {
    .card-pad { padding:28px 22px !important; }
    .h1 { font-size:24px !important; }
  }
`;

export function renderEmail(subject: string, layout: EmailLayout): EmailContent {
  const p = (html: string, extra = '') =>
    `<p class="muted" style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${LIGHT.muted};${extra}">${html}</p>`;

  const paragraphs = layout.paragraphs.map((text) => p(richText(text))).join('');

  const steps = layout.steps?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 20px;">${layout.steps.map((step, i) => `
        <tr>
          <td valign="top" width="34" style="padding:0 0 14px;">
            <div class="num" style="width:24px;height:24px;border-radius:12px;background:${LIGHT.brand};color:${LIGHT.buttonText};font-family:${FONT};font-size:13px;font-weight:700;line-height:24px;text-align:center;">${i + 1}</div>
          </td>
          <td valign="top" class="txt" style="padding:1px 0 14px;font-family:${FONT};font-size:16px;line-height:1.5;color:${LIGHT.text};">${richText(step)}</td>
        </tr>`).join('')}
      </table>`
    : '';

  const code = layout.code
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 12px;">
        <tr><td align="center" class="code" style="background:${LIGHT.codeBg};border:1px solid ${LIGHT.line};border-radius:14px;padding:22px 12px;font-family:'SF Mono', Menlo, Consolas, monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${LIGHT.text};">${escapeEmail(layout.code)}</td></tr>
      </table>
      ${layout.codeNote ? p(escapeEmail(layout.codeNote), 'font-size:14px;text-align:center;') : ''}`
    : '';

  const details = layout.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;border-top:1px solid ${LIGHT.line};" class="line">${layout.details.map(([label, value]) => `
        <tr>
          <td class="muted line" style="padding:10px 12px 10px 0;border-bottom:1px solid ${LIGHT.line};font-family:${FONT};font-size:14px;color:${LIGHT.muted};white-space:nowrap;vertical-align:top;">${escapeEmail(label)}</td>
          <td class="txt line" style="padding:10px 0;border-bottom:1px solid ${LIGHT.line};font-family:${FONT};font-size:14px;color:${LIGHT.text};word-break:break-word;">${escapeEmail(value)}</td>
        </tr>`).join('')}
      </table>`
    : '';

  const cta = layout.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
        <tr><td class="btn" style="background:${LIGHT.brand};border-radius:999px;">
          <a href="${escapeEmail(layout.cta.url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:600;color:${LIGHT.buttonText};text-decoration:none;">${escapeEmail(layout.cta.label)}</a>
        </td></tr>
      </table>`
    : '';

  const closing = layout.closing ? p(richText(layout.closing)) : '';
  const privacyUrl = `${layout.baseUrl}/privacy`;
  const footerLinks = [
    layout.unsubscribeUrl ? `<a href="${escapeEmail(layout.unsubscribeUrl)}" class="faint" style="color:${LIGHT.faint};text-decoration:underline;">Darte de baja</a>` : '',
    `<a href="${escapeEmail(privacyUrl)}" class="faint" style="color:${LIGHT.faint};text-decoration:underline;">Privacidad</a>`,
    `<a href="mailto:${escapeEmail(layout.supportEmail)}" class="faint" style="color:${LIGHT.faint};text-decoration:underline;">Soporte</a>`,
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeEmail(subject)}</title>
<style>${STYLE}</style>
</head>
<body class="page" style="margin:0;padding:0;background:${LIGHT.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeEmail(layout.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="page" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${LIGHT.page};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">
      <tr><td style="padding:0 4px 18px;font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:-0.3px;">
        <span class="txt" style="color:${LIGHT.text};">Runna</span><span class="brand" style="color:${LIGHT.brand};">.io</span>
      </td></tr>
      <tr><td class="card card-pad" style="background:${LIGHT.card};border:1px solid ${LIGHT.line};border-radius:20px;padding:36px 32px;">
        <h1 class="txt h1" style="margin:0 0 16px;font-family:${FONT};font-size:26px;line-height:1.25;font-weight:700;letter-spacing:-0.4px;color:${LIGHT.text};">${escapeEmail(layout.heading)}</h1>
        ${paragraphs}${steps}${code}${details}${cta}${closing}
        <p class="txt" style="margin:8px 0 0;font-family:${FONT};font-size:16px;line-height:1.6;color:${LIGHT.text};">El equipo de Runna.io</p>
      </td></tr>
      <tr><td style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${LIGHT.faint};" class="faint">
        ${escapeEmail(layout.reason)}<br>${footerLinks}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  // Plain-text twin (multipart/alternative): same content, links written out
  const lines: string[] = [layout.heading, ''];
  for (const text of layout.paragraphs) lines.push(plain(text), '');
  if (layout.steps?.length) {
    layout.steps.forEach((step, i) => lines.push(`${i + 1}. ${plain(step)}`));
    lines.push('');
  }
  if (layout.code) {
    lines.push(`    ${layout.code}`, '');
    if (layout.codeNote) lines.push(layout.codeNote, '');
  }
  if (layout.details?.length) {
    for (const [label, value] of layout.details) lines.push(`${label}: ${value}`);
    lines.push('');
  }
  if (layout.cta) lines.push(`${layout.cta.label}: ${layout.cta.url}`, '');
  if (layout.closing) lines.push(plain(layout.closing), '');
  lines.push('El equipo de Runna.io', '', '--', layout.reason);
  if (layout.unsubscribeUrl) lines.push(`Darte de baja: ${layout.unsubscribeUrl}`);
  lines.push(`Privacidad: ${privacyUrl}`, `Soporte: ${layout.supportEmail}`);

  return { subject, html, text: lines.join('\n') };
}

// ─── The emails ───────────────────────────────────────────────────────────────

export interface TemplateContext {
  baseUrl: string;
  supportEmail: string;
}

const openUrl = (ctx: TemplateContext, tab?: string) => `${ctx.baseUrl}/open${tab ? `?tab=${tab}` : ''}`;

export function welcomeEmail(ctx: TemplateContext, name: string, unsubscribeUrl?: string): EmailContent {
  const first = name.trim().split(/\s+/)[0] || name;
  return renderEmail(`Bienvenido a Runna.io, ${first}`, {
    ...ctx,
    preheader: 'Cada carrera que acabes convierte en tuyo un trozo de tu ciudad.',
    heading: `Bienvenido, ${first}`,
    paragraphs: [
      'Ya tienes cuenta. Ahora viene lo bueno: cada carrera que acabes convierte en **tuyo** el trozo de ciudad que encierra tu recorrido.',
      'Para empezar con buen pie:',
    ],
    steps: [
      '**Sal a correr** con la app, o conecta tu reloj para que tus carreras lleguen solas.',
      '**Invita a un amigo.** Así podréis robaros territorio.',
      '**Únete a un club** de tu ciudad y compite con él cada dos semanas.',
    ],
    cta: { label: 'Abrir Runna.io', url: openUrl(ctx, 'map') },
    closing: 'Nos vemos en el mapa.',
    reason: 'Te escribimos porque acabas de crear tu cuenta en Runna.io.',
    unsubscribeUrl,
  });
}

export function signupCodeEmail(ctx: TemplateContext, name: string, code: string, minutes: number): EmailContent {
  const first = name.trim().split(/\s+/)[0] || name;
  return renderEmail(`Tu código de Runna.io: ${code}`, {
    ...ctx,
    preheader: `Escríbelo en la app para terminar de crear tu cuenta. Caduca en ${minutes} minutos.`,
    heading: `Hola, ${first}`,
    paragraphs: ['Escribe este código en la app para terminar de crear tu cuenta:'],
    code,
    codeNote: `Caduca en ${minutes} minutos.`,
    closing: 'Si no has sido tú, ignora este correo: no se creará ninguna cuenta.',
    reason: 'Te escribimos porque alguien ha empezado a crear una cuenta de Runna.io con este correo.',
  });
}

export function passwordResetEmail(ctx: TemplateContext, name: string, code: string, minutes: number): EmailContent {
  const first = name.trim().split(/\s+/)[0] || name;
  return renderEmail(`Tu código para cambiar la contraseña: ${code}`, {
    ...ctx,
    preheader: `Escríbelo en la app para elegir una contraseña nueva. Caduca en ${minutes} minutos.`,
    heading: `Hola, ${first}`,
    paragraphs: ['Escribe este código en la app para elegir una contraseña nueva:'],
    code,
    codeNote: `Caduca en ${minutes} minutos.`,
    closing: 'Si no lo has pedido tú, ignora este correo: tu contraseña sigue siendo la misma.',
    reason: 'Te escribimos porque se ha pedido cambiar la contraseña de tu cuenta de Runna.io.',
  });
}

export function verificationCodeEmail(ctx: TemplateContext, name: string, code: string): EmailContent {
  const first = name.trim().split(/\s+/)[0] || name;
  return renderEmail(`Tu código de Runna.io: ${code}`, {
    ...ctx,
    preheader: 'Escríbelo en la app para confirmar tu correo.',
    heading: `Hola, ${first}`,
    paragraphs: ['Escribe este código en la app para confirmar tu correo:'],
    code,
    codeNote: 'Caduca en 10 minutos.',
    closing: 'Si no has sido tú, ignora este correo.',
    reason: 'Te escribimos porque se ha pedido confirmar este correo en Runna.io.',
  });
}

export function friendRequestEmail(ctx: TemplateContext, senderName: string, senderUsername: string, unsubscribeUrl?: string): EmailContent {
  return renderEmail(`${senderName} quiere ser tu amigo en Runna.io`, {
    ...ctx,
    preheader: 'Acepta y podréis ver el territorio del otro y robároslo.',
    heading: `${senderName} quiere ser tu amigo`,
    paragraphs: [`**${senderName}** (@${senderUsername}) te ha enviado una solicitud de amistad. Si la aceptas, veréis el territorio del otro y podréis robároslo.`],
    cta: { label: 'Ver solicitud', url: openUrl(ctx, 'friends') },
    reason: 'Te escribimos porque alguien te ha enviado una solicitud de amistad en Runna.io.',
    unsubscribeUrl,
  });
}

export function friendAcceptedEmail(ctx: TemplateContext, acceptorName: string, acceptorUsername: string, unsubscribeUrl?: string): EmailContent {
  return renderEmail(`${acceptorName} ha aceptado tu solicitud`, {
    ...ctx,
    preheader: 'Ya sois amigos en Runna.io. Que empiece la batalla por la ciudad.',
    heading: 'Ya sois amigos',
    paragraphs: [`**${acceptorName}** (@${acceptorUsername}) ha aceptado tu solicitud. Ya podéis ver el territorio del otro y robároslo.`],
    cta: { label: 'Ver su perfil', url: openUrl(ctx, 'friends') },
    reason: 'Te escribimos porque alguien ha aceptado tu solicitud de amistad en Runna.io.',
    unsubscribeUrl,
  });
}

export function territoryStolenEmail(ctx: TemplateContext, thiefName: string, thiefUsername: string, areaM2: number, unsubscribeUrl?: string): EmailContent {
  const km2 = (areaM2 / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 2 });
  return renderEmail(`${thiefName} te ha robado ${km2} km²`, {
    ...ctx,
    preheader: 'Sal a correr y recupéralo.',
    heading: 'Te han robado territorio',
    paragraphs: [`**${thiefName}** (@${thiefUsername}) te ha robado **${km2} km²**. Sal a correr por esa zona para recuperarlo.`],
    cta: { label: 'Ver el mapa', url: openUrl(ctx, 'map') },
    reason: 'Te escribimos porque alguien te ha robado territorio en Runna.io.',
    unsubscribeUrl,
  });
}

export function reportEmail(ctx: TemplateContext, report: { reporter: string; reported: string; targetType: string; targetId: string; reason: string }): EmailContent {
  return renderEmail(`Nueva denuncia en Runna.io: ${report.targetType}`, {
    ...ctx,
    preheader: `${report.reporter} ha denunciado a ${report.reported}.`,
    heading: 'Nueva denuncia',
    paragraphs: ['Revísala en menos de 24 horas, como prometen las condiciones de la app.'],
    details: [
      ['Denuncia', report.reporter],
      ['Denunciado', report.reported],
      ['Tipo', report.targetType],
      ['Motivo', report.reason],
      ['ID', report.targetId],
    ],
    cta: { label: 'Revisar en el panel', url: `${ctx.baseUrl}/admin/reports` },
    reason: 'Te llega porque eres el administrador de Runna.io.',
  });
}

export function testEmail(ctx: TemplateContext): EmailContent {
  return renderEmail('Prueba de correo de Runna.io', {
    ...ctx,
    preheader: 'Si lees esto, los correos funcionan.',
    heading: 'Todo funciona',
    paragraphs: ['Si lees esto, el servidor de Runna.io puede enviar correos. Mira si ha llegado a la bandeja de entrada y cómo se ve en modo claro y oscuro.'],
    cta: { label: 'Abrir Runna.io', url: openUrl(ctx) },
    reason: 'Te llega porque se ha pedido una prueba desde el panel de administración.',
  });
}

// ─── Samples (admin panel → Correos) ──────────────────────────────────────────

export const SAMPLE_KINDS = ['welcome', 'signup', 'reset', 'friend_request', 'friend_accepted', 'territory', 'report'] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

export const SAMPLE_NAMES: Record<SampleKind, string> = {
  welcome: 'Bienvenida',
  signup: 'Código de registro',
  reset: 'Cambiar contraseña',
  friend_request: 'Solicitud de amistad',
  friend_accepted: 'Solicitud aceptada',
  territory: 'Territorio robado',
  report: 'Denuncia (solo te llega a ti)',
};

/** Each email with made-up data. */
export function sampleEmail(ctx: TemplateContext, kind: SampleKind, unsubscribeUrl?: string): EmailContent {
  switch (kind) {
    case 'welcome': return welcomeEmail(ctx, 'Lucía Martín', unsubscribeUrl);
    case 'signup': return signupCodeEmail(ctx, 'Lucía', '482913', 15);
    case 'reset': return passwordResetEmail(ctx, 'Lucía', '730562', 15);
    case 'friend_request': return friendRequestEmail(ctx, 'Marta Gil', 'martagil', unsubscribeUrl);
    case 'friend_accepted': return friendAcceptedEmail(ctx, 'Marta Gil', 'martagil', unsubscribeUrl);
    case 'territory': return territoryStolenEmail(ctx, 'Marta Gil', 'martagil', 84_000, unsubscribeUrl);
    case 'report': return reportEmail(ctx, { reporter: 'Lucía Martín', reported: 'Marta Gil', targetType: 'comment', targetId: 'ejemplo', reason: 'Lenguaje ofensivo' });
  }
}
