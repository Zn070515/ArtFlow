import { describe, expect, it } from "vitest";

import { createSmtpMailerFromEnv } from "../src/mail-service.js";

describe("SMTP mailer", () => {
  it("stays disabled unless both the URL and sender are set", () => {
    expect(createSmtpMailerFromEnv({})).toBeNull();
    expect(createSmtpMailerFromEnv({ ARTFLOW_PLUS_SMTP_URL: "smtp://localhost:25" })).toBeNull();
    expect(createSmtpMailerFromEnv({ ARTFLOW_PLUS_MAIL_FROM: "no-reply@example.com" })).toBeNull();
  });

  it("creates a mailer from generic SMTP settings", () => {
    expect(createSmtpMailerFromEnv({
      ARTFLOW_PLUS_SMTP_URL: "smtp://user:pass@127.0.0.1:2525",
      ARTFLOW_PLUS_MAIL_FROM: "ArtFlow <no-reply@example.com>",
    })).not.toBeNull();
  });
});
