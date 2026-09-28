import { describe, expect, it } from "vitest";
import { sanitizeSvgText } from "./svg-sanitize";

describe("sanitizeSvgText", () => {
  it("escapes ampersands", () => {
    expect(sanitizeSvgText("Ben & Jerry's")).toBe("Ben &amp; Jerry&apos;s");
  });

  it("escapes angle brackets", () => {
    expect(sanitizeSvgText("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("escapes double quotes", () => {
    expect(sanitizeSvgText('He said "hello"')).toBe("He said &quot;hello&quot;");
  });

  it("escapes single quotes", () => {
    expect(sanitizeSvgText("It's")).toBe("It&apos;s");
  });

  it("escapes all five XML entities simultaneously", () => {
    const input = `Tom & Jerry's "show" <best>`;
    const expected = `Tom &amp; Jerry&apos;s &quot;show&quot; &lt;best&gt;`;
    expect(sanitizeSvgText(input)).toBe(expected);
  });

  it("returns plain text unchanged", () => {
    expect(sanitizeSvgText("Hello World")).toBe("Hello World");
  });

  it("handles empty string", () => {
    expect(sanitizeSvgText("")).toBe("");
  });

  it("handles string with only special characters", () => {
    expect(sanitizeSvgText("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&apos;");
  });

  it("does not double-encode already safe text", () => {
    const safe = "Acme Corp - Best Products 2024";
    expect(sanitizeSvgText(safe)).toBe(safe);
  });
});
