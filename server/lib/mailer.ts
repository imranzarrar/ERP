import nodemailer from 'nodemailer';

// SMTP credentials come from the environment only — never hardcoded, never logged.
// isMailerConfigured() gates every caller so an unconfigured server fails with a clear,
// actionable error instead of nodemailer throwing deep inside a request handler.
function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const fromAddress = process.env.SMTP_FROM || user;
  if (!host || !port || !user || !pass) return null;
  // A bare address in the From header shows the raw mailbox (e.g.
  // "warraq.compbrain@gmail.com") to the recipient — pairing it with a display name
  // (nodemailer's `{name, address}` form, standard RFC 5322) shows "Warraq Portal"
  // instead, same as any real product's outbound mail. SMTP_FROM_NAME is overridable per
  // deployment but defaults to this app's own name so it works with zero extra config.
  const from = { name: process.env.SMTP_FROM_NAME || 'Warraq Portal', address: fromAddress };
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

// Fired the moment someone submits the public onboarding form (server/routes/
// onboarding.ts's public POST) — proves they actually control contactEmail before a
// super-admin ever sees the request (see that route's own comment for the full reasoning).
// Deliberately not "your request was received" wording — nothing has actually been
// received by a human yet at this point, only stored pending confirmation.
export async function sendOnboardingEmailConfirmation(to: string, confirmUrl: string, companyName: string): Promise<void> {
  const config = getSmtpConfig();
  if (!config) throw new Error('SMTP is not configured (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD missing from environment).');
  const transporter = getTransporter();
  await transporter.sendMail({
    from: config.from,
    to,
    subject: `Confirm your email to submit "${companyName}"'s registration`,
    text: `Thanks for starting a registration for "${companyName}".\n\nConfirm this is really your email address to send your request to our team for review. This link expires in 1 hour and can only be used once.\n\n${confirmUrl}\n\nIf you didn't request this, you can safely ignore this email — no request will be submitted.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1e1b4b;">Confirm your email</h2>
        <p>Thanks for starting a registration for <strong>${companyName}</strong>.</p>
        <p>Confirm this is really your email address to send your request to our team for review. This link expires in <strong>1 hour</strong> and can only be used once.</p>
        <p style="margin: 24px 0;">
          <a href="${confirmUrl}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Confirm Email</a>
        </p>
        <p style="color:#64748b;font-size:12px;">If you didn't request this, you can safely ignore this email — no request will be submitted.</p>
      </div>
    `,
  });
}

// Fired once the submitter has confirmed their email (see sendOnboardingEmailConfirmation
// above and the public confirm-email route) — sent to every super-admin with an email on
// file, not a single fixed address, so this keeps working with no extra config as
// super-admins come and go. Best-effort/fire-and-forget by every caller — a mail failure
// must never block the confirmation itself from succeeding.
export async function sendOnboardingReceivedEmail(toAdmins: string[], request: { companyName: string; contactName: string; contactEmail: string }): Promise<void> {
  const config = getSmtpConfig();
  if (!config || toAdmins.length === 0) return;
  const transporter = getTransporter();
  await transporter.sendMail({
    from: config.from,
    to: toAdmins.join(','),
    subject: `New company onboarding request: ${request.companyName}`,
    text: `A new company onboarding request was submitted and the contact's email is confirmed.\n\nCompany: ${request.companyName}\nContact: ${request.contactName} (${request.contactEmail})\n\nReview it in Admin Settings > Onboarding Requests.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1e1b4b;">New company onboarding request</h2>
        <p style="color:#16a34a;font-size:12px;font-weight:bold;">✓ Contact email confirmed</p>
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
