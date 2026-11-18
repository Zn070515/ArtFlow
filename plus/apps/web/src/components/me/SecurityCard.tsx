import { useQueryClient } from "@tanstack/react-query";
import { useState, type SubmitEvent } from "react";

import { confirmMfa, disableMfa, enrollMfa, type MfaEnrollment } from "../../api/auth.js";
import { useSession } from "../../auth/SessionProvider.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Input } from "../ui/Input.js";

export function SecurityCard() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (session === null) return null;

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await enrollMfa());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法开始两步验证。");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmMfa(code);
      setNotice("两步验证已启用。下次登录需要输入验证码。");
      setEnrollment(null);
      setCode("");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "验证码不正确。");
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await disableMfa(password, code);
      setNotice("两步验证已关闭。");
      setCode("");
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法关闭两步验证。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="security-card">
      <h2 className="ui-card__title">账号安全</h2>
      {session.mfaEnabled === true ? (
        <form className="auth-form" onSubmit={(event) => void disable(event)}>
          <p className="ui-card__description">两步验证已启用。关闭它需要密码和当前验证码。</p>
          <Input
            label="密码"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <Input
            label="验证码"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            minLength={6}
            maxLength={6}
            required
          />
          <Button variant="secondary" type="submit" disabled={busy}>关闭两步验证</Button>
        </form>
      ) : enrollment === null ? (
        <div>
          <p className="ui-card__description">
            为正式活动操作增加一道保护。使用任意 TOTP 应用（如 1Password、Microsoft Authenticator）扫描二维码。
          </p>
          <Button variant="secondary" onClick={() => void start()} disabled={busy}>启用两步验证</Button>
        </div>
      ) : (
        <form className="auth-form" onSubmit={(event) => void confirm(event)}>
          <p className="ui-card__description">在验证器应用中添加以下密钥，然后输入当前 6 位验证码。</p>
          <code className="definition-raw">{enrollment.secret}</code>
          <a className="auth-switch" href={enrollment.otpauthUrl}>在验证器中打开</a>
          <Input
            label="验证码"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            minLength={6}
            maxLength={6}
            required
          />
          <Button variant="primary" type="submit" disabled={busy}>确认启用</Button>
        </form>
      )}
      {notice === null ? null : <p className="ui-card__description">{notice}</p>}
      {error === null ? null : <p className="ui-field__error" role="alert">{error}</p>}
    </Card>
  );
}
