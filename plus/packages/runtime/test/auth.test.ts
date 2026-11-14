import { expect, it } from "vitest";

import { hashPassword, validateRegistrationPassword, verifyPassword } from "../src/auth-service.js";

it("hashes passwords with a unique salt and verifies only the original password", async () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");

  expect(first).not.toBe(second);
  await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
  await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
});

it("rejects short, common, and username-equal registration passwords", () => {
  expect(() => validateRegistrationPassword("password", "alice")).toThrow(/12-128/);
  expect(() => validateRegistrationPassword("password1234", "alice")).toThrow(/common/);
  expect(() => validateRegistrationPassword("alicealice12", "alicealice12")).toThrow(/username/);
  expect(() => validateRegistrationPassword("correct horse battery staple", "alice")).not.toThrow();
});
