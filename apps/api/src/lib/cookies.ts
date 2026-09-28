import type { Response, CookieOptions } from "express";

type SecureCookieOptions = Omit<CookieOptions, "secure" | "sameSite"> & {
  httpOnly?: boolean;
  sameSite?: "strict" | "none";
};

/**
 * Set a response cookie with Secure and SameSite=Strict enforced.
 * httpOnly defaults to true; pass false only when JS read access is required
 * and the call site documents the reason.
 */
export function setCookieSecure(
  res: Response,
  name: string,
  value: string,
  options: SecureCookieOptions = {}
): void {
  const { httpOnly = true, sameSite = "strict", ...rest } = options;
  res.cookie(name, value, {
    ...rest,
    secure: true,
    httpOnly,
    sameSite,
  });
}
