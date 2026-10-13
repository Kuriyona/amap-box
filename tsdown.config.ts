import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/gen_svg.ts", "src/cli/review.ts"],
  format: ["esm", "cjs"],
  dts: true,
});
