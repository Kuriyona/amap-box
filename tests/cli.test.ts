import { describe, expect, it } from "vitest";
import { renderNameTemplate } from "../src/cli/common.js";

describe("renderNameTemplate", () => {
  it("替换 {name} / {adcode} / {up} / {down}", () => {
    const region = { name: "杭州市", adcode: "330100", up: 1, down: 0 };
    expect(renderNameTemplate("{adcode}.svg", region)).toBe("330100.svg");
    expect(renderNameTemplate("杭州-{adcode}-u{up}d{down}", region)).toBe("杭州-330100-u1d0.svg");
  });

  it("非法字符换 _，且自动补 .svg 后缀", () => {
    expect(renderNameTemplate("{name}/{adcode}", { name: "杭州市/西湖区", adcode: "330100", up: 0, down: 0 })).toBe(
      "杭州市_西湖区_330100.svg",
    );
    expect(renderNameTemplate("plain", { name: "x", adcode: "1", up: 0, down: 0 })).toBe("plain.svg");
  });
});
