import { expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/auth-service.js";

it("hashes passwords with a unique salt and verifies only the original password", () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");

  expect(first).not.toBe(second);
  expect(verifyPassword("correct horse battery staple", first)).toBe(true);
  expect(verifyPassword("wrong password", first)).toBe(false);
});
