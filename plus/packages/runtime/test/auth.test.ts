import { expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/auth-service.js";

it("hashes passwords with a unique salt and verifies only the original password", async () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");

  expect(first).not.toBe(second);
  await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
  await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
});
