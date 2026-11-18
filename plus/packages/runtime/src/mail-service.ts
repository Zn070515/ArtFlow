import nodemailer from "nodemailer";

export interface PasswordResetMessage {
  readonly to: string;
  readonly username: string;
  readonly resetUrl: string;
  readonly expiresAt: string;
}

export interface Mailer {
  sendPasswordReset(message: PasswordResetMessage): Promise<void>;
}

/**
 * SMTP is deliberately generic: the deployment supplies a URL and a From
 * address, so school mail, Aliyun DirectMail and Tencent SES all work without
 * provider-specific code. Without both values password reset is disabled.
 */
export function createSmtpMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  const url = env.ARTFLOW_PLUS_SMTP_URL;
  const from = env.ARTFLOW_PLUS_MAIL_FROM;
  if (url === undefined || url.trim() === "" || from === undefined || from.trim() === "") {
    return null;
  }
  const transporter = nodemailer.createTransport(url);
  return {
    async sendPasswordReset(message) {
      const subject = "ArtFlow 密码重置";
      const text = [
        `你好 ${message.username}，`,
        "",
        "有人请求重置 ArtFlow 账号密码。打开下面的链接设置新密码：",
        message.resetUrl,
        "",
        `链接在 ${message.expiresAt} 前有效，且只能使用一次。`,
        "如果不是你发起的，请忽略这封邮件。",
      ].join("\n");
      await transporter.sendMail({
        from,
        to: message.to,
        subject,
        text,
        html: `<p>你好 ${escapeHtml(message.username)}，</p>
<p>有人请求重置 ArtFlow 账号密码。点击下面的链接设置新密码：</p>
<p><a href="${escapeHtml(message.resetUrl)}">设置新密码</a></p>
<p>链接在 ${escapeHtml(message.expiresAt)} 前有效，且只能使用一次。</p>
<p>如果不是你发起的，请忽略这封邮件。</p>`,
      });
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
