import nodemailer from 'nodemailer';

// SMTP credentials come from the environment only — never hardcoded, never logged.
// isMailerConfigured() gates every caller so an unconfigured server fails with a clear,
// actionable error instead of nodemailer throwing deep inside a request handler.
function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM || user;
  if (!host || !port || !user || !pass) return null;
  return { host, port: Number(port), user, pass, from };
}

export function isMailerConfigured(): boolean {
  return getSmtpConfig() !== null;
}

let cachedTransporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter {
  const config = getSmtpConfig();
  if (!config) {
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD missing from environment).');
  }
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // 465 is the conventional implicit-TLS SMTP port; every other port (587, 25, ...)
      // uses STARTTLS instead, which nodemailer negotiates automatically when secure: false.
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
  }
  return cachedTransporter;
}

export async function sendPasswordResetEmail(to: string, resetUrl: string, username: string): Promise<void> {
  const config = getSmtpConfig();
  if (!config) {
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD missing from environment).');
  }
  const transporter = getTransporter();
  await transporter.sendMail({
    from: config.from,
    to,
    subject: 'Reset your ERP portal password',
    text: `Hello ${username},\n\nA password reset was requested for your account. Click the link below to choose a new password. This link expires in 1 hour and can only be used once.\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email — your password will not be changed.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1e1b4b;">Reset your password</h2>
        <p>Hello <strong>${username}</strong>,</p>
        <p>A password reset was requested for your account. Click the button below to choose a new password. This link expires in <strong>1 hour</strong> and can only be used once.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Reset Password</a>
        </p>
        <p style="color:#64748b;font-size:12px;">If you did not request this, you can safely ignore this email — your password will not be changed.</p>
      </div>
    `,
  });
}

// Fired the moment a new company-onboarding request is submitted (server/routes/
// onboarding.ts's public POST) — sent to every super-admin with an email on file, not a
// single fixed address, so this keeps working with no extra config as super-admins come
// and go. Best-effort/fire-and-forget by every caller — a mail failure must never block
// the public submission itself from succeeding.
export async function sendOnboardingReceivedEmail(toAdmins: string[], request: { companyName: string; contactName: string; contactEmail: string }): Promise<void> {
  const config = getSmtpConfig();
  if (!config || toAdmins.length === 0) return;
  const transporter = getTransporter();
  await transporter.sendMail({
    from: config.from,
    to: toAdmins.join(','),
    subject: `New company onboarding request: ${request.companyName}`,
    text: `A new company onboarding request was submitted.\n\nCompany: ${request.companyName}\nContact: ${request.contactName} (${request.contactEmail})\n\nReview it in Admin Settings > Onboarding Requests.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1e1b4b;">New company onboarding request</h2>
        <p><strong>Company:</strong> ${request.companyName}</p>
        <p><strong>Contact:</strong> ${request.contactName} (${request.contactEmail})</p>
        <p style="color:#64748b;font-size:12px;">Review it in Admin Settings &gt; Onboarding Requests.</p>
      </div>
    `,
  });
}

// Fired once an onboarding request is approved and the new user's password-reset token
// has been issued — this is the ONLY way the new user ever gets access; no plaintext
// password is ever generated or emailed (see server/routes/onboarding.ts).
export async function sendOnboardingApprovedEmail(to: string, resetUrl: string, companyName: string): Promise<void> {
  const config = getSmtpConfig();
  if (!config) throw new Error('SMTP is not configured (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD missing from environment).');
  const transporter = getTransporter();
  await transporter.sendMail({
    from: config.from,
    to,
    subject: `Your company account "${companyName}" is ready`,
    text: `Good news — "${companyName}" has been approved and your account is ready.\n\nSet your password to get started. This link expires in 1 hour and can only be used once.\n\n${resetUrl}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1e1b4b;">Your account is ready</h2>
        <p>Good news — <strong>${companyName}</strong> has been approved and your account is ready.</p>
        <p>Set your password to get started. This link expires in <strong>1 hour</strong> and can only be used once.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Set Your Password</a>
        </p>
      </div>
    `,
  });
}

export async function sendOnboardingRejectedEmail(to: string, companyName: string, reason?: string): Promise<void> {
  const config = getSmtpConfig();
  if (!config) throw new Error('SMTP is not configured (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD missing from environment).');
  const transporter = getTransporter();
  const reasonText = reason ? `\n\nReason: ${reason}` : '';
  const reasonHtml = reason ? `<p><strong>Reason:</strong> ${reason}</p>` : '';
  await transporter.sendMail({
    from: config.from,
    to,
    subject: `Update on your "${companyName}" account request`,
    text: `Thanks for your interest in setting up "${companyName}". After review, we're not able to proceed with this request at this time.${reasonText}\n\nIf you have questions, feel free to reach out to us directly.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1e1b4b;">Update on your account request</h2>
        <p>Thanks for your interest in setting up <strong>${companyName}</strong>. After review, we're not able to proceed with this request at this time.</p>
        ${reasonHtml}
        <p style="color:#64748b;font-size:12px;">If you have questions, feel free to reach out to us directly.</p>
      </div>
    `,
  });
}
